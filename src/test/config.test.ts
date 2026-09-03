import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createDemoMockHarness } from "../harness/mock.js";
import { DEFAULT_CONFIG, mergeConfig, modelForRole, pickConfigFile, readConfigFile, validateConfig } from "../runtime/config.js";
import { buildPiModelsJson, discoverModels, expandEnv, materializePiModels, toPiModel } from "../runtime/providers.js";
import { startFakeOpenAI } from "./fake-openai.js";
import { runHoh } from "../runtime/loop.js";
import { readJson, RunPaths } from "../runtime/state.js";
import type { HohConfig } from "../runtime/config.js";
import type { RunConfig } from "../types.js";
import { makeWorkspace } from "./helpers.js";

test("config: merge, per-role model fallback, validation", () => {
  const c = mergeConfig(DEFAULT_CONFIG, { harness: "pi", models: { default: "a/x", tester: "b/y:high" }, checks: [{ name: "b", command: "true" }] });
  assert.equal(modelForRole(c, "planner"), "a/x");
  assert.equal(modelForRole(c, "developer"), "a/x");
  assert.equal(modelForRole(c, "tester"), "b/y:high");
  assert.deepEqual(validateConfig(c), []);

  const bad = mergeConfig(DEFAULT_CONFIG, { harness: "pi", loops: 0, artifact_dir: "../out", checks: [{ name: "", command: "" }] } as any);
  const errors = validateConfig(bad);
  assert.ok(errors.some((e) => /loops/.test(e)));
  assert.ok(errors.some((e) => /artifact_dir/.test(e)));
  assert.ok(errors.some((e) => /models.default/.test(e)), "pi harness requires a model");
  assert.ok(errors.some((e) => /checks\[0\].name/.test(e)));

  // mock harness needs no model
  assert.deepEqual(validateConfig(mergeConfig(DEFAULT_CONFIG, { harness: "mock" })), []);
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
    const run = (await readJson<RunConfig>(paths.runJson))!;
    assert.equal(run.config_source, "test");
    assert.match(await readFile(paths.readme, "utf8"), /tester=m\/tester:high/);

    // Resume without overrides: stored config is used; a loops override extends the budget and is stored.
    const again = await runHoh({ workspace: ws, harness, config: { loops: 2 } });
    assert.equal(again.results.length, 1);
    assert.equal(again.results[0].evidence.usage.model, "mock:m/tester:high");
    assert.equal((await readJson<HohConfig>(paths.config))!.loops, 2);

    // A harness that does not match the configured one is refused.
    await assert.rejects(runHoh({ workspace: ws, harness: { name: "pi", invoke: async () => ({ finalText: "", submissions: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, turns: 0 }) } }), /configured harness is "mock"/);
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
