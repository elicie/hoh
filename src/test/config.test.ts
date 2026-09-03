import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createDemoMockHarness } from "../harness/mock.js";
import { DEFAULT_CONFIG, mergeConfig, modelForRole, piCompactionForRole, pickConfigFile, readConfigFile, validateConfig } from "../runtime/config.js";
import { buildPiModelsJson, discoverModels, expandEnv, materializePiModels, toPiModel } from "../runtime/providers.js";
import { startFakeOpenAI } from "./fake-openai.js";
import { runHoh } from "../runtime/loop.js";
import { buildProtocolReceipt, canonicalSha256 } from "../runtime/protocol.js";
import { readJson, RunPaths } from "../runtime/state.js";
import type { HohConfig } from "../runtime/config.js";
import type { RunConfig } from "../types.js";
import { makeWorkspace } from "./helpers.js";

test("config: merge, per-role model fallback, validation", async () => {
  const c = mergeConfig(DEFAULT_CONFIG, { harness: "pi", models: { default: "a/x", tester: "b/y:high" }, checks: [{ name: "b", command: "true" }] });
  assert.equal(modelForRole(c, "planner"), "a/x");
  assert.equal(modelForRole(c, "developer"), "a/x");
  assert.equal(modelForRole(c, "tester"), "b/y:high");
  assert.equal(c.protocol, "extended", "missing protocol preserves legacy behavior");
  assert.equal(c.retry.max_retries, 3);
  assert.equal(c.timeouts.output_idle_ms, 300_000);
  assert.deepEqual(piCompactionForRole(c, "planner"), { enabled: true, reserve_tokens: 16_384, keep_recent_tokens: 20_000 });
  assert.deepEqual(validateConfig(c), []);

  const paper = mergeConfig(DEFAULT_CONFIG, { protocol: "paper", harness: "mock", models: { default: "a/x" } });
  assert.deepEqual(validateConfig(paper), []);
  const splitPaper = mergeConfig(paper, { models: { tester: "b/y:high" } });
  assert.ok(validateConfig(splitPaper).some((e) => /paper protocol requires one identical model pattern/.test(e)));
  assert.ok(validateConfig(mergeConfig(DEFAULT_CONFIG, { protocol: null } as any)).some((e) => /protocol must be/.test(e)));
  assert.equal(canonicalSha256({ b: 2, a: { d: 4, c: 3 } }), canonicalSha256({ a: { c: 3, d: 4 }, b: 2 }));

  const divergentResolver = createDemoMockHarness();
  let resolution = 0;
  Object.defineProperty(divergentResolver, "resolveModel", { value: async () => `mock:resolved-${(resolution += 1)}` });
  await assert.rejects(
    buildProtocolReceipt(paper, divergentResolver, { legacyDefault: false, origin: "run_start" }),
    /paper protocol requires one identical resolved model\/reasoning identity/,
  );

  const bad = mergeConfig(DEFAULT_CONFIG, { harness: "pi", loops: 0, artifact_dir: "../out", checks: [{ name: "", command: "" }] } as any);
  const errors = validateConfig(bad);
  assert.ok(errors.some((e) => /loops/.test(e)));
  assert.ok(errors.some((e) => /artifact_dir/.test(e)));
  assert.ok(errors.some((e) => /models.default/.test(e)), "pi harness requires a model");
  assert.ok(errors.some((e) => /checks\[0\].name/.test(e)));
  assert.ok(
    validateConfig(
      mergeConfig(DEFAULT_CONFIG, {
        harness: "mock",
        retry: { max_retries: -1 },
        timeouts: { output_idle_ms: 0 },
      }),
    ).some((e) => /retry\.max_retries/.test(e)),
  );
  assert.ok(
    validateConfig(mergeConfig(DEFAULT_CONFIG, { harness: "mock", timeouts: { output_idle_ms: 0 } })).some((e) =>
      /timeouts\.output_idle_ms/.test(e),
    ),
  );

  for (const artifact_dir of [
    "nested/../../outside",
    ".hoh",
    "./.hoh/iterations",
    "line\nbreak",
    "windows\\separator",
    "./game",
    "a/../b",
    "a//b",
    "a/",
    "C:/x",
  ]) {
    assert.ok(
      validateConfig(mergeConfig(DEFAULT_CONFIG, { harness: "mock", artifact_dir })).some((e) => /artifact_dir/.test(e)),
      `${JSON.stringify(artifact_dir)} must not escape into the workspace parent or runtime records`,
    );
  }
  assert.ok(
    !validateConfig(mergeConfig(DEFAULT_CONFIG, { harness: "mock", artifact_dir: "..cache" })).some((e) => /artifact_dir/.test(e)),
    "a literal in-workspace directory beginning with dots remains valid",
  );

  // mock harness needs no model
  assert.deepEqual(validateConfig(mergeConfig(DEFAULT_CONFIG, { harness: "mock" })), []);

  const compacted = mergeConfig(DEFAULT_CONFIG, {
    harness: "mock",
    pi: {
      compaction: { enabled: true, reserve_tokens: 24_000, keep_recent_tokens: 12_000 },
      roles: { developer: { compaction: { enabled: false } } },
    },
  });
  assert.deepEqual(piCompactionForRole(compacted, "planner"), {
    enabled: true,
    reserve_tokens: 24_000,
    keep_recent_tokens: 12_000,
  });
  assert.deepEqual(piCompactionForRole(compacted, "developer"), {
    enabled: false,
    reserve_tokens: 24_000,
    keep_recent_tokens: 12_000,
  });
  assert.ok(
    validateConfig(
      mergeConfig(DEFAULT_CONFIG, { harness: "mock", pi: { roles: { tester: { compaction: { reserve_tokens: 0 } } } } }),
    ).some((error) => /pi\.roles\.tester\.compaction\.reserve_tokens/.test(error)),
  );
});

test("config: file resolution order and unknown keys", async () => {
  const { ws, cleanup } = await makeWorkspace();
  try {
    const cwd = path.join(path.dirname(ws), "tool");
    await mkdir(cwd, { recursive: true });
    await mkdir(ws, { recursive: true });

    assert.deepEqual(await pickConfigFile({ workspace: ws, cwd }), { file: null, source: "built-in defaults" });

    const toolFile = path.join(cwd, "hoh.config.json");
    await writeFile(toolFile, JSON.stringify({ harness: "mock", loops: 2 }));
    assert.deepEqual(await pickConfigFile({ workspace: ws, cwd }), { file: toolFile, source: toolFile });

    await mkdir(path.join(ws, ".hoh"), { recursive: true });
    await writeFile(path.join(ws, ".hoh", "config.json"), JSON.stringify({ harness: "mock" }));
    const picked = await pickConfigFile({ workspace: ws, cwd });
    assert.equal(picked.file, null, "the run's own config wins over the tool-level file");
    assert.match(picked.source, /\.hoh\/config\.json$/);

    const explicit = path.join(cwd, "other.json");
    await writeFile(explicit, JSON.stringify({ harness: "mock", loops: 5 }));
    assert.equal((await pickConfigFile({ explicit, workspace: ws, cwd })).file, explicit);

    await writeFile(explicit, JSON.stringify({ harness: "mock", worktree_setup: "npm ci" }));
    assert.equal((await readConfigFile(explicit)).worktree_setup, "npm ci");

    await writeFile(explicit, JSON.stringify({ harness: "mock", model: "typo" }));
    await assert.rejects(readConfigFile(explicit), /unknown key "model"/);
    await writeFile(explicit, "{ not json");
    await assert.rejects(readConfigFile(explicit), /not valid JSON/);
  } finally {
    await cleanup();
  }
});

test("config: per-role models reach the harness and the run record; stored config is reused on resume", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const harness = createDemoMockHarness();
    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness,
      config: { harness: "mock", loops: 1, models: { default: "m/default", tester: "m/tester:high" }, timeouts: { role_min: 5 } },
      configSource: "test",
    });
    const paths = new RunPaths(ws);
    const byRole = Object.fromEntries(harness.calls.map((c) => [c.role, c.model]));
    assert.deepEqual(byRole, { planner: "m/default", developer: "m/default", tester: "m/tester:high" });
    assert.equal(result.results[0].planner.usage.model, "mock:m/default");
    assert.equal(result.results[0].evidence.usage.model, "mock:m/tester:high");

    const stored = (await readJson<HohConfig>(paths.config))!;
    assert.equal(stored.loops, 1);
    assert.equal(stored.timeouts.role_min, 5);
    assert.equal(stored.timeouts.check_min, 10, "unspecified values fall back to defaults");
    assert.equal(stored.timeouts.provider_ms, 3_600_000);
    assert.equal(stored.retry.max_retries, 3);
    const run = (await readJson<RunConfig>(paths.runJson))!;
    assert.equal(run.config_source, "test");
    assert.equal(run.protocol_receipt?.mode, "extended");
    assert.equal(run.protocol_receipt?.legacy_default, true);
    assert.equal(run.protocol_receipt?.origin, "run_start");
    assert.match(run.protocol_receipt?.protocol_sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(await readFile(paths.readme, "utf8"), /tester=m\/tester:high/);
    assert.match(await readFile(paths.readme, "utf8"), /Protocol:\*\* EXTENDED \(legacy default\)/);

    // Resume without overrides: stored config is used; a loops override extends the budget and is stored.
    const again = await runHoh({ workspace: ws, harness, config: { loops: 2 } });
    assert.equal(again.results.length, 1);
    assert.equal(again.results[0].evidence.usage.model, "mock:m/tester:high");
    assert.equal((await readJson<HohConfig>(paths.config))!.loops, 2);

    const configBeforeArtifactDirChange = await readFile(paths.config, "utf8");
    const runBeforeArtifactDirChange = await readFile(paths.runJson, "utf8");
    await assert.rejects(runHoh({ workspace: ws, harness, config: { artifact_dir: "game" } }), /cannot change artifact_dir/);
    assert.equal(await readFile(paths.config, "utf8"), configBeforeArtifactDirChange);
    assert.equal(await readFile(paths.runJson, "utf8"), runBeforeArtifactDirChange);

    // A pre-receipt run migrates forward as legacy extended, never as paper.
    const legacyRun = (await readJson<RunConfig>(paths.runJson))! as RunConfig & { protocol_receipt?: unknown };
    const legacyConfig = (await readJson<HohConfig>(paths.config))! as HohConfig & { protocol?: unknown };
    delete legacyRun.protocol_receipt;
    delete (legacyRun.config as Partial<HohConfig>).protocol;
    delete (legacyConfig as Partial<HohConfig>).protocol;
    await writeFile(paths.runJson, `${JSON.stringify(legacyRun, null, 2)}\n`);
    await writeFile(paths.config, `${JSON.stringify(legacyConfig, null, 2)}\n`);
    await assert.rejects(
      runHoh({
        workspace: ws,
        harness,
        config: { protocol: "paper", models: { default: "m/shared", planner: "m/shared", developer: "m/shared", tester: "m/shared" } },
      }),
      /cannot change run protocol from extended to paper/,
    );
    const migrated = await runHoh({ workspace: ws, harness });
    assert.equal(migrated.results.length, 0);
    assert.equal(migrated.run.protocol_receipt?.mode, "extended");
    assert.equal(migrated.run.protocol_receipt?.legacy_default, true);
    assert.equal(migrated.run.protocol_receipt?.origin, "legacy_reconstruction");

    // A harness that does not match the configured one is refused.
    await assert.rejects(runHoh({ workspace: ws, harness: { name: "pi", invoke: async () => ({ finalText: "", submissions: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, turns: 0 }) } }), /configured harness is "mock"/);
  } finally {
    await cleanup();
  }
});

test("config: paper protocol receipt locks models, role contracts, runtime policy, and T on resume", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const harness = createDemoMockHarness();
    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness,
      config: { protocol: "paper", harness: "mock", loops: 1, models: { default: "m/shared:high" } },
      configSource: "paper-test",
    });
    const paths = new RunPaths(ws);
    const receipt = result.run.protocol_receipt!;
    assert.equal(receipt.mode, "paper");
    assert.equal(receipt.legacy_default, false);
    assert.equal(receipt.origin, "run_start");
    assert.equal(receipt.initial_loops, 1);
    assert.deepEqual(receipt.models, {
      planner: "mock:m/shared:high",
      developer: "mock:m/shared:high",
      tester: "mock:m/shared:high",
    });
    assert.equal(receipt.harness.version, "builtin-1");
    assert.deepEqual(receipt.role_contracts.planner.builtin_tools, ["read", "grep", "find", "ls"]);
    assert.deepEqual(receipt.role_contracts.tester.structured_tools, ["submit_evidence"]);
    assert.equal(receipt.role_contracts.tester.workspace, "isolated-read-only");
    assert.match(receipt.protocol_sha256, /^[0-9a-f]{64}$/);

    const resumed = await runHoh({ workspace: ws, harness });
    assert.equal(resumed.results.length, 0);
    assert.equal(resumed.run.protocol_receipt?.protocol_sha256, receipt.protocol_sha256);
    const configBeforeRejectedResume = await readFile(paths.config, "utf8");
    const runBeforeRejectedResume = await readFile(paths.runJson, "utf8");

    await assert.rejects(
      runHoh({ workspace: ws, harness, config: { loops: 2 } }),
      /cannot resume paper run .*protocol contract changed/,
    );
    assert.equal(await readFile(paths.config, "utf8"), configBeforeRejectedResume, "a rejected resume must not rewrite config");
    assert.equal(await readFile(paths.runJson, "utf8"), runBeforeRejectedResume, "a rejected resume must not rewrite run receipt");

    await assert.rejects(
      runHoh({
        workspace: ws,
        harness,
        config: { models: { default: "m/other:high", planner: "m/other:high", developer: "m/other:high", tester: "m/other:high" } },
      }),
      /cannot resume paper run .*protocol contract changed/,
    );
    await assert.rejects(
      runHoh({ workspace: ws, harness, config: { checks: [{ name: "new-policy", command: "true" }] } }),
      /cannot resume paper run .*protocol contract changed/,
    );

    await assert.rejects(
      runHoh({ workspace: ws, harness, config: { protocol: "extended" } }),
      /cannot change run protocol from paper to extended/,
    );

    const changedHarness = createDemoMockHarness();
    Object.defineProperty(changedHarness, "version", { value: "builtin-2" });
    await assert.rejects(runHoh({ workspace: ws, harness: changedHarness }), /cannot resume paper run .*protocol contract changed/);
    assert.equal(await readFile(paths.config, "utf8"), configBeforeRejectedResume);
    assert.equal(await readFile(paths.runJson, "utf8"), runBeforeRejectedResume);

    const tamperedRun = JSON.parse(runBeforeRejectedResume) as RunConfig;
    tamperedRun.protocol_receipt!.models.planner = "mock:tampered";
    const tamperedText = `${JSON.stringify(tamperedRun, null, 2)}\n`;
    await writeFile(paths.runJson, tamperedText);
    await assert.rejects(runHoh({ workspace: ws, harness }), /stored protocol receipt failed its integrity check/);
    assert.equal(await readFile(paths.runJson, "utf8"), tamperedText, "an invalid receipt must not be rewritten");
  } finally {
    await cleanup();
  }
});

test("providers: validation rules", () => {
  const ok = mergeConfig(DEFAULT_CONFIG, {
    harness: "pi",
    providers: {
      gw: { base_url: "https://gw.example.com/v1", api_key: "$GW_KEY", models: "discover" },
      local: { base_url: "http://localhost:11434/v1", api_key: "ollama", models: ["m1", { id: "m2" }] },
    },
    models: { default: "gw/anything", tester: "local/m2:high" },
  });
  assert.deepEqual(validateConfig(ok), []);

  const bad = mergeConfig(DEFAULT_CONFIG, {
    harness: "pi",
    providers: {
      Bad_Name: { base_url: "ftp://x", api_key: "literal-secret", api: "grpc" as any, models: "nope" as any },
      remote: { base_url: "https://gw.example.com/v1", api_key: "literal-secret", models: ["a"] },
    },
    models: { default: "remote/b" },
  });
  const errors = validateConfig(bad);
  assert.ok(errors.some((e) => /provider names/.test(e)));
  assert.ok(errors.some((e) => /base_url/.test(e)));
  assert.ok(errors.some((e) => /\.api must be/.test(e)));
  assert.ok(errors.some((e) => /providers\.remote\.api_key must be "\$ENV_VAR"/.test(e)), "literal keys are rejected for non-loopback hosts");
  assert.ok(errors.some((e) => /models must be "discover"/.test(e)));
  assert.ok(errors.some((e) => /models\.default references remote\/b/.test(e)));
});

test("providers: pi models.json mapping and env expansion", async () => {
  process.env.T_BASE = "https://gw.example.com";
  assert.equal(expandEnv("$T_BASE/v1", "x"), "https://gw.example.com/v1");
  assert.equal(expandEnv("${T_BASE}/v1", "x"), "https://gw.example.com/v1");
  assert.throws(() => expandEnv("$T_UNSET_VAR", "providers.gw.base_url"), /T_UNSET_VAR, which is not set/);

  const cfg = mergeConfig(DEFAULT_CONFIG, {
    harness: "pi",
    providers: {
      gw: {
        base_url: "$T_BASE/v1",
        api_key: "$GW_KEY",
        headers: { "X-Org": "$ORG" },
        compat: { supports_developer_role: false },
        models: ["plain", { id: "rich", name: "Rich", reasoning: true, context_window: 1000, max_tokens: 10, input: ["text", "image"], compat: { supports_reasoning_effort: false } }],
        model_defaults: { context_window: 64000, max_tokens: 4096 },
        model_overrides: { plain: { reasoning: true } },
      },
    },
    models: { default: "gw/plain" },
  });
  const json = await buildPiModelsJson(cfg);
  const gw = json.providers.gw;
  assert.equal(gw.baseUrl, "https://gw.example.com/v1");
  assert.equal(gw.apiKey, "$GW_KEY", "api key reference is passed to pi unresolved");
  assert.deepEqual(gw.headers, { "X-Org": "$ORG" });
  assert.deepEqual(gw.compat, { supportsDeveloperRole: false });
  assert.deepEqual(gw.models[0], { id: "plain", reasoning: true, contextWindow: 64000, maxTokens: 4096 });
  assert.deepEqual(gw.models[1], { id: "rich", name: "Rich", reasoning: true, input: ["text", "image"], contextWindow: 1000, maxTokens: 10, compat: { supportsReasoningEffort: false } });
  assert.deepEqual(toPiModel("x", { base_url: "u", models: [] }), { id: "x" });
});

test("providers: discovery filters non-chat models, honours include/exclude, and falls back to the previous file", async () => {
  const server = await startFakeOpenAI(() => ({ text: "" }), { models: ["gpt-a", "gpt-b", "dall-e-image", "whisper-1", "tts-1"], apiKey: "k" });
  try {
    process.env.DISC_KEY = "k";
    const base = { base_url: server.baseUrl, api_key: "$DISC_KEY", models: "discover" as const };
    assert.deepEqual((await discoverModels("p", base)).map((m) => m.id), ["gpt-a", "gpt-b"]);
    assert.deepEqual((await discoverModels("p", { ...base, discover: { include: ["gpt-b"] } })).map((m) => m.id), ["gpt-b"]);
    assert.deepEqual((await discoverModels("p", { ...base, discover: { exclude: ["gpt-a"] } })).map((m) => m.id), ["dall-e-image", "gpt-b", "tts-1", "whisper-1"]);

    process.env.DISC_KEY = "wrong";
    await assert.rejects(discoverModels("p", base), /HTTP 401/);
    const cfg = mergeConfig(DEFAULT_CONFIG, { harness: "pi", providers: { p: base }, models: { default: "p/gpt-a" } });
    const previous = { providers: { p: { baseUrl: server.baseUrl, api: "openai-completions", models: [{ id: "gpt-a" }] } } };
    const logs: string[] = [];
    const rebuilt = await buildPiModelsJson(cfg, { previous, log: (m) => logs.push(m) });
    assert.deepEqual(rebuilt.providers.p.models, [{ id: "gpt-a" }]);
    assert.match(logs.join("\n"), /reusing 1 previously discovered/);
    await assert.rejects(buildPiModelsJson(cfg), /HTTP 401/);
  } finally {
    await server.close();
  }
});

test("providers: the generated pi models file is stable across invocations", async () => {
  const server = await startFakeOpenAI(() => ({ text: "" }), { models: ["gpt-a"] });
  const { mkdtemp, rm, stat } = await import("node:fs/promises");
  const os = await import("node:os");
  const dir = await mkdtemp(path.join(os.tmpdir(), "hoh-models-"));
  try {
    const cfg = mergeConfig(DEFAULT_CONFIG, { harness: "pi", providers: { p: { base_url: server.baseUrl, models: "discover" } }, models: { default: "p/gpt-a" } });
    const file = path.join(dir, "pi-models.json");
    await materializePiModels(cfg, file);
    const first = await stat(file);
    await new Promise((r) => setTimeout(r, 20));
    await materializePiModels(cfg, file);
    const second = await stat(file);
    assert.equal(first.mtimeMs, second.mtimeMs, "unchanged content is not rewritten");
    assert.equal(JSON.parse(await readFile(file, "utf8")).hoh.generated_at, undefined);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
