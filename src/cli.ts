#!/usr/bin/env node
/**
 * hoh — Harness-of-Harness runtime CLI
 *
 *   hoh run    --workspace <dir> --spec <PRD.md> [--config <file>] [--loops <n>]
 *   hoh status --workspace <dir>
 *   hoh config --workspace <dir> [--config <file>]
 *
 * Models, providers (OpenAI-compatible endpoints), harness, checks and
 * timeouts are managed in hoh.config.json, not in CLI flags.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";
import { createHarness, createModelRuntime } from "./harness/factory.js";
import {
  CONFIG_FILE_NAME,
  type ConfigPatch,
  DEFAULT_CONFIG,
  type HohConfig,
  mergeConfig,
  modelForRole,
  pickConfigFile,
  readConfigFile,
  validateConfig,
} from "./runtime/config.js";
import { ledgerSummary } from "./runtime/ledger.js";
import { runHoh } from "./runtime/loop.js";
import { collectLoops } from "./runtime/report.js";
import { loadLedger, loadRun, readJson, RunPaths } from "./runtime/state.js";
import { ROLES } from "./types.js";

const USAGE = `hoh — Harness-of-Harness runtime on top of the pi coding agent

Usage:
  hoh run    --workspace <dir> --spec <PRD.md> [--config <file>] [--loops <n>]
  hoh status --workspace <dir>
  hoh config --workspace <dir> [--config <file>]      effective config, discovered models, per-role resolution

Configuration (${CONFIG_FILE_NAME}) — providers, models, harness, budget, checks, timeouts:
  1. --config <file>                  explicit
  2. <workspace>/.hoh/config.json     the run's own config, editable between invocations
  3. ./${CONFIG_FILE_NAME}             tool-level default in the current directory
  4. built-in defaults

  --loops <n> overrides the budget for this invocation (and is stored).

Secrets: api_key values are "$ENV_VAR" references. \`.env\` files in the current directory and in the
workspace are loaded automatically (existing environment variables win).
`;

function loadEnvFiles(workspace: string, log: (m: string) => void): void {
  const seen = new Set<string>();
  for (const dir of [process.cwd(), workspace]) {
    const file = path.join(dir, ".env");
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    try {
      process.loadEnvFile(file);
      log(`loaded ${file}`);
    } catch (err: any) {
      log(`could not load ${file}: ${err?.message ?? err}`);
    }
  }
}

interface Resolved {
  workspace: string;
  patch: ConfigPatch | null;
  source: string;
  effective: HohConfig;
}

async function resolve(values: { workspace?: string; config?: string; loops?: string }): Promise<Resolved> {
  const workspace = path.resolve(values.workspace ?? process.cwd());
  const paths = new RunPaths(workspace);
  const picked = await pickConfigFile({ explicit: values.config, workspace, cwd: process.cwd() });
  let patch: ConfigPatch | null = picked.file ? await readConfigFile(picked.file) : null;
  if (values.loops !== undefined) {
    const loops = Number(values.loops);
    if (!Number.isInteger(loops) || loops < 1) throw new Error("--loops must be a positive integer");
    patch = { ...(patch ?? {}), loops };
  }
  const stored = await readJson<HohConfig>(paths.config);
  const effective = mergeConfig(stored ? mergeConfig(DEFAULT_CONFIG, stored) : DEFAULT_CONFIG, patch);
  return { workspace, patch, source: picked.source + (values.loops !== undefined ? ` + --loops ${values.loops}` : ""), effective };
}

async function showConfig(r: Resolved, log: (m: string) => void): Promise<number> {
  const errors = validateConfig(r.effective);
  process.stdout.write(`Workspace: ${r.workspace}\nConfig source: ${r.source}\n\n${JSON.stringify(r.effective, null, 2)}\n\n`);
  if (errors.length) {
    process.stdout.write(`Invalid:\n  - ${errors.join("\n  - ")}\n`);
    return 1;
  }
  if (r.effective.harness !== "pi") {
    for (const role of ROLES) process.stdout.write(`  ${role.padEnd(9)} ${modelForRole(r.effective, role) ?? "(mock)"}\n`);
    return 0;
  }
  const { modelRuntime, models, modelsPath } = await createModelRuntime(r.effective, r.workspace, { log });
  if (models) {
    process.stdout.write(`Providers (pi models file: ${modelsPath}):\n`);
    for (const [name, p] of Object.entries(models.providers)) {
      const discovered = models.hoh?.discovered[name];
      process.stdout.write(`  ${name}: ${p.baseUrl} [${p.api}] — ${p.models.length} model(s)${discovered ? " (discovered)" : ""}\n`);
      for (const m of p.models) process.stdout.write(`    ${m.id}${m.reasoning ? "  (reasoning)" : ""}\n`);
    }
    process.stdout.write("\n");
  }
  const available = new Set((await modelRuntime.getAvailable()).map((m) => `${m.provider}/${m.id}`));
  let ok = true;
  process.stdout.write("Models per role:\n");
  for (const role of ROLES) {
    const pattern = modelForRole(r.effective, role);
    if (!pattern) {
      process.stdout.write(`  ${role.padEnd(9)} (harness default)\n`);
      continue;
    }
    const res = resolveCliModel({ cliModel: pattern, modelRuntime });
    if (res.error || !res.model) {
      ok = false;
      process.stdout.write(`  ${role.padEnd(9)} ${pattern}  -> NOT FOUND: ${res.error ?? "no match"}\n`);
      continue;
    }
    const id = `${res.model.provider}/${res.model.id}`;
    const provider = r.effective.providers[res.model.provider];
    const hint = provider?.api_key?.startsWith("$") ? `set ${provider.api_key} (env or .env)` : "npx pi → /login, or API key env var";
    const auth = available.has(id) ? "auth ok" : `NO CREDENTIALS (${hint})`;
    if (!available.has(id)) ok = false;
    process.stdout.write(`  ${role.padEnd(9)} ${pattern}  -> ${id}${res.thinkingLevel ? ` (thinking ${res.thinkingLevel})` : ""}  [${auth}]\n`);
  }
  return ok ? 0 : 1;
}

async function showStatus(workspace: string): Promise<number> {
  const paths = new RunPaths(workspace);
  const run = await loadRun(paths);
  if (!run) {
    process.stdout.write(`No HoH run in ${workspace}\n`);
    return 1;
  }
  const ledger = await loadLedger(paths);
  const s = ledgerSummary(ledger);
  const loops = await collectLoops(paths);
  const models = ROLES.map((r) => `${r}=${modelForRole(run.config, r) ?? "(harness default)"}`).join(", ");
  process.stdout.write(`Run ${run.run_id} — harness ${run.config.harness}, budget ${run.config.loops} loops\nModels: ${models}\n`);
  process.stdout.write(`Ledger: open ${s.open}, regressed ${s.regressed}, closed ${s.closed}, all ${s.all}\n\n`);
  process.stdout.write("Loop  Candidate            QA        Verified/Gaps  Objective\n");
  for (const l of [...loops].reverse()) {
    const qa = l.evidence ? l.evidence.qa_status.toUpperCase() : l.error ? "ERROR" : "UNTESTED";
    process.stdout.write(
      `${String(l.index).padStart(4)}  ${(l.developer?.candidate_id ?? "-").padEnd(20)} ${qa.padEnd(9)} ${l.evidence ? `${l.evidence.verified_records.length}/${l.evidence.gap_records.length}`.padEnd(14) : "".padEnd(14)} ${l.planner?.objective ?? ""}\n`,
    );
  }
  process.stdout.write(`\nRecord: ${paths.readme}\nConfig: ${paths.config}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      workspace: { type: "string", short: "w" },
      spec: { type: "string", short: "s" },
      config: { type: "string", short: "c" },
      loops: { type: "string", short: "n" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  const log = (m: string) => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
  const workspace = path.resolve(values.workspace ?? process.cwd());

  if (cmd === "status") return showStatus(workspace);
  loadEnvFiles(workspace, log);
  const r = await resolve(values);
  if (cmd === "config") return showConfig(r, log);
  if (cmd !== "run") {
    process.stderr.write(`Unknown command "${cmd}"\n\n${USAGE}`);
    return 1;
  }

  if (values.spec) await readFile(values.spec, "utf8"); // fail early with a clear error
  const harness = await createHarness(r.effective, r.workspace, { log });
  const result = await runHoh({
    workspace: r.workspace,
    specPath: values.spec,
    harness,
    config: r.patch ?? undefined,
    configSource: r.source,
    log,
  });
  const s = ledgerSummary(result.ledger);
  log(`run ${result.run.run_id}: ${result.results.length} loop(s) executed; ledger open ${s.open}, regressed ${s.regressed}, closed ${s.closed}`);
  for (const x of result.results) {
    log(`  loop ${x.loopIndex}: ${x.evidence.qa_status.toUpperCase()} ${x.developer.candidate_id} — ${x.planner.objective}`);
  }
  log(`record: ${new RunPaths(r.workspace).readme}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`hoh: ${err?.message ?? err}\n`);
    process.exit(1);
  },
);
