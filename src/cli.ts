#!/usr/bin/env node
/**
 * hoh — Harness-of-Harness runtime CLI
 *
 *   hoh run    --workspace <dir> --spec <PRD.md> [--config <file>] [--loops <n>] [--detach]
 *   hoh init-claims --workspace <dir> --spec <PRD.md> [--config <file>]
 *   hoh status --workspace <dir>
 *   hoh verify --workspace <dir>
 *   hoh stop   --workspace <dir>
 *   hoh logs   --workspace <dir> [-f]
 *   hoh config --workspace <dir> [--config <file>]
 *
 * Models, providers (OpenAI-compatible endpoints), harness, checks and
 * timeouts are managed in hoh.config.json, not in CLI flags.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";
import { createHarness, createModelRuntime } from "./harness/factory.js";
import { initializeClaimState } from "./runtime/claims.js";
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
import {
  DEFAULT_STOP_WAIT_MS,
  DETACHED_CHILD_ENV,
  followLifecycleLog,
  launchDetachedRun,
  lifecycleIsActive,
  lifecycleProcessIsCurrent,
  readLifecycleLog,
  readLifecycleState,
  requestLifecycleStop,
  RunLifecycle,
  type LifecycleState,
  waitForLifecycleTerminal,
} from "./runtime/lifecycle.js";
import { runHoh } from "./runtime/loop.js";
import { coverageSummary, loadClaimCatalog, loadCoverage } from "./runtime/coverage.js";
import { commitAll, ensureRepo, RUNTIME_IDENTITY } from "./runtime/git.js";
import { collectLoops } from "./runtime/report.js";
import type { RunReceiptVerificationIssue } from "./runtime/receipt.js";
import { verifyCurrentRunReceipt } from "./runtime/run-receipt.js";
import { loadBudgetLedger, loadLedger, loadRun, readJson, RunPaths } from "./runtime/state.js";
import { ROLES, type BudgetLedger } from "./types.js";

const USAGE = `hoh — Harness-of-Harness runtime for supported coding-agent harnesses

Usage:
  hoh run    --workspace <dir> --spec <PRD.md> [--config <file>] [--loops <n>] [--detach]
  hoh init-claims --workspace <dir> --spec <PRD.md> [--config <file>]
  hoh status --workspace <dir>
  hoh verify --workspace <dir>                          offline run-receipt verification
  hoh stop   --workspace <dir>
  hoh logs   --workspace <dir> [-f]
  hoh config --workspace <dir> [--config <file>]      effective config, discovered models, per-role resolution

Configuration (${CONFIG_FILE_NAME}) — protocol, providers, models, harness, budget, checks, timeouts:
  1. --config <file>                  explicit
  2. <workspace>/.hoh/config.json     the run's own config; changes are accepted only for extended runs
  3. ./${CONFIG_FILE_NAME}             tool-level default in the current directory
  4. built-in defaults

  --loops <n> overrides the budget for an extended run. A paper run's initial budget is immutable.

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
  const stored = await readJson<ConfigPatch>(paths.config);
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
  if (r.effective.harness === "mock") {
    for (const role of ROLES) process.stdout.write(`  ${role.padEnd(9)} ${modelForRole(r.effective, role) ?? "(mock)"}\n`);
    return 0;
  }
  if (r.effective.harness === "codex") {
    const harness = await createHarness(r.effective, r.workspace, { log });
    process.stdout.write(`Codex adapter: ${harness.version ?? "unknown"}\nModels per role:\n`);
    for (const role of ROLES) {
      const pattern = modelForRole(r.effective, role);
      const resolved = await harness.resolveModel?.(pattern);
      process.stdout.write(`  ${role.padEnd(9)} ${pattern ?? "(missing)"}  -> ${resolved ?? "(unresolved)"}\n`);
    }
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
  let lifecycle: LifecycleState | null = null;
  try {
    lifecycle = await readLifecycleState(workspace);
  } catch {
    // A workspace without a repository can still produce the existing no-run response below.
  }
  if (lifecycle) printLifecycleStatus(lifecycle);
  const paths = new RunPaths(workspace);
  const run = await loadRun(paths);
  if (!run) {
    process.stdout.write(`No HoH run in ${workspace}\n`);
    return lifecycle ? 0 : 1;
  }
  const ledger = await loadLedger(paths);
  const s = ledgerSummary(ledger);
  const spec = await readFile(paths.spec, "utf8");
  const catalog = await loadClaimCatalog(paths, spec);
  const coverage = catalog ? await loadCoverage(paths, catalog) : null;
  const loops = await collectLoops(paths);
  const budget = await loadBudgetLedger(paths);
  const models = ROLES.map((r) => `${r}=${modelForRole(run.config, r) ?? "(harness default)"}`).join(", ");
  const protocolReceipt = run.protocol_receipt;
  const runReceipt = await verifyCurrentRunReceipt(workspace);
  process.stdout.write(
    `Run ${run.run_id} — protocol ${(protocolReceipt?.mode ?? run.config.protocol ?? "extended").toUpperCase()}${protocolReceipt?.legacy_default ? " (legacy default)" : ""}${protocolReceipt?.origin === "legacy_reconstruction" ? " (receipt reconstructed)" : ""}, harness ${run.config.harness}, budget ${run.config.loops} loops\n`,
  );
  if (protocolReceipt) process.stdout.write(`Protocol receipt: ${protocolReceipt.protocol_sha256}\n`);
  process.stdout.write(
    runReceipt.ok
      ? `Run receipt: VERIFIED ${runReceipt.receipt!.receipt_sha256}\n`
      : `Run receipt: INVALID (${runReceipt.issues.map((issue) => issue.code).join(", ")})\n`,
  );
  process.stdout.write(`Models: ${models}\n`);
  if (budget) printBudgetStatus(budget);
  process.stdout.write(`Ledger: open ${s.open}, regressed ${s.regressed}, closed ${s.closed}, all ${s.all}\n\n`);
  if (catalog && coverage) {
    const c = coverageSummary(catalog, coverage);
    process.stdout.write(`Coverage: verified ${c.verified}, untested ${c.untested}, gap ${c.gap}, all ${c.all}\n\n`);
  }
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

async function showVerify(workspace: string): Promise<number> {
  const result = await verifyCurrentRunReceipt(workspace);
  if (result.ok) {
    const candidate = result.receipt!.candidate;
    process.stdout.write(
      `Run receipt VERIFIED: ${result.receipt!.receipt_sha256}\n` +
        `Artifacts: ${result.receipt!.artifacts.length}\n` +
        `Candidate: ${candidate ? `${candidate.commit_oid} / ${candidate.tree_oid}` : "none"}\n`,
    );
    return 0;
  }
  process.stderr.write(`Run receipt verification FAILED for ${workspace}\n`);
  for (const issue of result.issues) process.stderr.write(`  - ${formatVerificationIssue(issue)}\n`);
  return 1;
}

function formatVerificationIssue(issue: RunReceiptVerificationIssue): string {
  const location = issue.path ? ` ${issue.path}` : issue.artifact_name ? ` ${issue.artifact_name}` : "";
  const mismatch = issue.expected || issue.actual ? ` (expected ${issue.expected ?? "?"}, actual ${issue.actual ?? "?"})` : "";
  return `[${issue.code}]${location}: ${issue.message}${mismatch}`;
}

function printBudgetStatus(budget: BudgetLedger): void {
  process.stdout.write(
    `Resource budget: ${budget.status.toUpperCase()} — elapsed ${formatElapsed(budget.totals.elapsed_ms)}, tokens ${budget.totals.total_tokens.toLocaleString("en-US")}, cost $${budget.totals.cost.toFixed(6)}\n`,
  );
  if (budget.current_role) {
    const current = budget.current_role;
    const activeMs = Math.max(0, Date.now() - Date.parse(current.started_at));
    process.stdout.write(
      `Budget role: loop ${current.loop_index} / ${current.role}, active ${formatElapsed(activeMs)}; ceilings ${formatBudgetCeiling("role", budget.limits.role)}, ${formatBudgetCeiling("loop", budget.limits.loop)}, ${formatBudgetCeiling("run", budget.limits.run)}\n`,
    );
  }
  if (budget.exhaustion) {
    const hit = budget.exhaustion;
    process.stdout.write(
      `Budget exhaustion: ${hit.scope}${hit.loop_index ? ` loop ${hit.loop_index}` : ""}${hit.role ? ` ${hit.role}` : ""} ${hit.metric} ${hit.used} / ${hit.limit}${hit.before_role ? `; blocked before ${hit.before_role}` : ""}\n`,
    );
  }
}

function formatBudgetCeiling(scope: "role" | "loop" | "run", limit: BudgetLedger["limits"][typeof scope]): string {
  if (!limit || Object.values(limit).every((value) => value === undefined)) return `${scope}=unlimited`;
  const values = [
    limit.elapsed_ms === undefined ? null : `${formatElapsed(limit.elapsed_ms)} elapsed`,
    limit.total_tokens === undefined ? null : `${limit.total_tokens.toLocaleString("en-US")} tokens`,
    limit.cost === undefined ? null : `$${limit.cost.toFixed(6)}`,
  ].filter((value): value is string => value !== null);
  return `${scope}=${values.join("/")}`;
}

function printLifecycleStatus(state: LifecycleState): void {
  const active = lifecycleIsActive(state);
  const alive = active && lifecycleProcessIsCurrent(state);
  const effectiveStatus = active && !alive ? "STALE" : state.status.toUpperCase();
  const loop = state.loop_index === null ? "loop -" : `loop ${state.loop_index}`;
  const elapsedEnd = active ? Date.now() : Date.parse(state.updated_at);
  const elapsed = formatElapsed(elapsedEnd - Date.parse(state.started_at));
  process.stdout.write(
    `Lifecycle: ${effectiveStatus} (pid ${state.pid}${active ? `, ${alive ? "alive" : "missing"}` : ""}) — ${loop}, role ${state.phase}, elapsed ${elapsed}\n`,
  );
  if (state.message) process.stdout.write(`Lifecycle message: ${state.message}\n`);
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(0)}s`;
}

async function stopRun(workspace: string): Promise<number> {
  const request = await requestLifecycleStop(workspace);
  if (!request.requested || !request.state) {
    const suffix = request.reason === "process-missing" ? " (recorded process is missing)" : "";
    process.stdout.write(`No active HoH run in ${workspace}${suffix}\n`);
    return 1;
  }
  process.stdout.write(`Stop requested for HoH pid ${request.state.pid}; waiting for runtime cleanup...\n`);
  const terminal = await waitForLifecycleTerminal(workspace, request.state.instance_id);
  if (terminal?.instance_id === request.state.instance_id && lifecycleIsActive(terminal)) {
    process.stderr.write(
      `HoH pid ${request.state.pid} did not stop within ${DEFAULT_STOP_WAIT_MS / 1_000}s; the stop request remains pending.\n`,
    );
    return 1;
  }
  process.stdout.write(`HoH pid ${request.state.pid} stopped${terminal ? ` (${terminal.status})` : ""}.\n`);
  return 0;
}

async function showLogs(workspace: string, follow: boolean): Promise<number> {
  if (!follow) {
    process.stdout.write(await readLifecycleLog(workspace));
    return 0;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await followLifecycleLog(workspace, (chunk) => process.stdout.write(chunk), controller.signal);
    return 0;
  } catch (error) {
    if (controller.signal.aborted) return 130;
    throw error;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
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
      detach: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
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

  if (values.detach && cmd !== "run") throw new Error("--detach is only valid with run");
  if (values.follow && cmd !== "logs") throw new Error("--follow/-f is only valid with logs");
  if (cmd === "status") return showStatus(workspace);
  if (cmd === "verify") return showVerify(workspace);
  if (cmd === "stop") return stopRun(workspace);
  if (cmd === "logs") return showLogs(workspace, values.follow ?? false);
  if (cmd === "run" && values.detach && process.env[DETACHED_CHILD_ENV] !== "1") {
    if (values.spec) await readFile(values.spec, "utf8");
    await mkdir(workspace, { recursive: true });
    await ensureRepo(workspace);
    const detached = await launchDetachedRun({
      workspace,
      cliPath: process.argv[1],
      args: argv.filter((arg) => arg !== "--detach"),
    });
    const action = lifecycleIsActive(detached.state) ? "Started detached HoH run" : `Detached HoH run ${detached.state.status}`;
    process.stdout.write(`${action} (pid ${detached.pid}).\nLog: ${detached.logPath}\n`);
    return 0;
  }
  if (cmd === "run") {
    if (values.spec) await readFile(values.spec, "utf8");
    await mkdir(workspace, { recursive: true });
    await ensureRepo(workspace);
    const lifecycle = await RunLifecycle.start(workspace);
    const detachedChild = process.env[DETACHED_CHILD_ENV] === "1";
    const runLog = (message: string) => {
      lifecycle.observe(message);
      const line = `${new Date().toISOString()} ${message}\n`;
      if (!detachedChild) lifecycle.appendLog(line);
      process.stderr.write(line);
    };
    try {
      loadEnvFiles(workspace, runLog);
      const r = await resolve(values);
      const harness = await createHarness(r.effective, r.workspace, { log: runLog });
      lifecycle.signal.throwIfAborted();
      const result = await runHoh({
        workspace: r.workspace,
        specPath: values.spec,
        harness,
        config: r.patch ?? undefined,
        configSource: r.source,
        log: runLog,
        signal: lifecycle.signal,
      });
      lifecycle.signal.throwIfAborted();
      const s = ledgerSummary(result.ledger);
      runLog(`run ${result.run.run_id}: ${result.results.length} loop(s) executed; ledger open ${s.open}, regressed ${s.regressed}, closed ${s.closed}`);
      for (const x of result.results) {
        runLog(`  loop ${x.loopIndex}: ${x.evidence.qa_status.toUpperCase()} ${x.developer.candidate_id} — ${x.planner.objective}`);
      }
      runLog(`record: ${new RunPaths(r.workspace).readme}`);
      if (result.status === "budget_exhausted") {
        const exhaustion = result.budget.exhaustion;
        const message = exhaustion
          ? `${exhaustion.scope} ${exhaustion.metric} budget exhausted (${exhaustion.used}/${exhaustion.limit})`
          : "resource budget exhausted";
        await lifecycle.finish("budget_exhausted", 0, message);
      } else {
        await lifecycle.finish("completed", 0);
      }
      return 0;
    } catch (error: any) {
      const stopped = lifecycle.signal.aborted && lifecycle.cancellationSource !== "control-error";
      const message = lifecycle.signal.reason instanceof Error ? lifecycle.signal.reason.message : error?.message ?? String(error);
      const exitCode = lifecycle.cancellationSource === "SIGTERM" ? 143 : 130;
      await lifecycle.finish(stopped ? "stopped" : "failed", stopped ? exitCode : 1, message);
      if (stopped) return exitCode;
      throw lifecycle.signal.reason ?? error;
    } finally {
      await lifecycle.close();
    }
  }
  loadEnvFiles(workspace, log);
  const r = await resolve(values);
  if (cmd === "config") return showConfig(r, log);
  if (cmd === "init-claims") {
    if (!values.spec) throw new Error("--spec is required for init-claims");
    const specPath = path.resolve(values.spec);
    const spec = await readFile(specPath, "utf8");
    await ensureRepo(r.workspace);
    const harness = await createHarness(r.effective, r.workspace, { log });
    const paths = new RunPaths(r.workspace);
    const state = await initializeClaimState({
      workspace: r.workspace,
      specPath,
      spec,
      harness,
      paths,
      model: modelForRole(r.effective, "planner"),
      timeoutMs: r.effective.timeouts.role_min * 60_000,
    });
    await commitAll(r.workspace, "chore(hoh): initialize fixed PRD claims", RUNTIME_IDENTITY, [
      ".hoh/claims.json",
      ".hoh/coverage.json",
      ".hoh/claims-transcript.jsonl",
    ]);
    process.stdout.write(
      `Initialized ${state.catalog.claims.length} fixed claim(s) in ${paths.claims}\nReview the catalog's completeness and required evidence types before running.\n`,
    );
    return 0;
  }
  process.stderr.write(`Unknown command "${cmd}"\n\n${USAGE}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`hoh: ${err?.message ?? err}\n`);
    process.exit(1);
  },
);
