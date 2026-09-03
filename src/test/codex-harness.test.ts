import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { CodexHarness, detectCodexVersion } from "../harness/codex.js";
import { createHarness } from "../harness/factory.js";
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from "../runtime/config.js";
import { runHoh } from "../runtime/loop.js";
import { buildProtocolReceipt } from "../runtime/protocol.js";
import { makeWorkspace } from "./helpers.js";

const fixture = path.resolve("src/test/fixtures/fake-codex-cli.mjs");

test("codex adapter uses the isolated non-interactive contract and maps schema output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hoh-codex-test-"));
  const record = path.join(directory, "record.json");
  const transcript: string[] = [];
  try {
    const harness = new CodexHarness({
      executable: process.execPath,
      executableArgs: [fixture],
      version: "codex-cli fixture-1.0.0",
      env: { FAKE_CODEX_RECORD: record },
    });
    assert.equal(await harness.resolveModel("codex/gpt-fixture:high"), "codex/gpt-fixture:high");
    assert.deepEqual(harness.rolePolicy("planner"), {
      workspace: "active-read-only",
      builtinTools: ["codex-exec:read-only"],
    });
    const result = await harness.invoke({
      role: "planner",
      loopIndex: 1,
      cwd: directory,
      systemPrompt: "SYSTEM CONTRACT SENTINEL",
      prompt: "USER PROMPT SENTINEL",
      tools: ["read", "grep", "find", "ls"],
      structuredTools: [{ name: "submit_fixture", description: "fixture", parameters: Type.Object({ ok: Type.Boolean() }) }],
      model: "codex/gpt-fixture:high",
      onTranscript: (chunk) => transcript.push(chunk),
    });
    assert.deepEqual(result.submissions.submit_fixture, [{ ok: true }]);
    assert.deepEqual(result.usage, { input: 120, output: 30, cacheRead: 20, cacheWrite: 0, totalTokens: 150, cost: 0 });
    assert.equal(result.turns, 1);
    assert.equal(result.model, "codex/gpt-fixture:high");
    const invocation = JSON.parse(await readFile(record, "utf8"));
    assert.equal(invocation.prompt, "USER PROMPT SENTINEL");
    assert.ok(invocation.args.includes("--ephemeral"));
    assert.ok(invocation.args.includes("--ignore-user-config"));
    assert.ok(invocation.args.includes("--ignore-rules"));
    assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "read-only");
    assert.ok(invocation.args.includes('developer_instructions="SYSTEM CONTRACT SENTINEL"'));
    assert.ok(invocation.args.includes('model_reasoning_effort="high"'));
    assert.match(transcript.join(""), /"adapter":"codex"/);
    assert.match(transcript.join(""), /"type":"turn.completed"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("codex adapter propagates cancellation and kills the CLI process", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hoh-codex-cancel-"));
  try {
    const harness = new CodexHarness({
      executable: process.execPath,
      executableArgs: [fixture],
      version: "codex-cli fixture-1.0.0",
      env: { FAKE_CODEX_WAIT_MS: "10000" },
    });
    const controller = new AbortController();
    const reason = new Error("operator stopped codex fixture");
    const pending = harness.invoke({
      role: "developer",
      loopIndex: 1,
      cwd: directory,
      systemPrompt: "system",
      prompt: "prompt",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      structuredTools: [],
      model: "codex/gpt-fixture:low",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 50);
    await assert.rejects(pending, (error) => error === reason);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("codex adapter records the exact CLI version", async () => {
  assert.equal(
    await detectCodexVersion({ executable: process.execPath, executableArgs: [fixture] }),
    "codex-cli fixture-1.0.0",
  );
});

test("codex adapter rejects an outer tool policy it cannot faithfully map", async () => {
  const harness = new CodexHarness({ version: "codex-cli fixture-1.0.0" });
  await assert.rejects(
    harness.invoke({
      role: "planner",
      loopIndex: 1,
      cwd: process.cwd(),
      systemPrompt: "system",
      prompt: "prompt",
      tools: ["read", "bash"],
      structuredTools: [],
      model: "codex/gpt-fixture:low",
    }),
    /unsupported outer tool policy/,
  );
});

test("codex factory completes a paper loop and receipts its native sandbox policy", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const config = mergeConfig(DEFAULT_CONFIG, {
      protocol: "paper",
      harness: "codex",
      loops: 1,
      models: { default: "codex/gpt-fixture:high" },
    });
    assert.deepEqual(validateConfig(config), []);
    const harness = await createHarness(config, ws, {
      codex: { executable: process.execPath, executableArgs: [fixture] },
    });
    assert.equal(harness.name, "codex");
    assert.equal(harness.version, "codex-cli fixture-1.0.0");

    const receipt = await buildProtocolReceipt(config, harness, { legacyDefault: false, origin: "run_start" });
    assert.deepEqual(receipt.models, {
      planner: "codex/gpt-fixture:high",
      developer: "codex/gpt-fixture:high",
      tester: "codex/gpt-fixture:high",
    });
    assert.deepEqual(receipt.role_contracts.planner.builtin_tools, ["codex-exec:read-only"]);
    assert.deepEqual(receipt.role_contracts.developer.builtin_tools, ["codex-exec:workspace-write"]);
    assert.deepEqual(receipt.role_contracts.tester.builtin_tools, ["codex-exec:workspace-write-on-frozen-copy"]);

    const result = await runHoh({ workspace: ws, specPath: spec, harness, config });
    assert.equal(result.status, "completed");
    assert.equal(result.results.length, 1);
    assert.equal(result.run.protocol_receipt?.harness.name, "codex");
    assert.equal(result.results[0].planner.usage.model, "codex/gpt-fixture:high");
    assert.equal(result.results[0].evidence.usage.model, "codex/gpt-fixture:high");
  } finally {
    await cleanup();
  }
});

test("codex config requires an explicit model and rejects unsupported monetary budgets", () => {
  assert.ok(
    validateConfig(mergeConfig(DEFAULT_CONFIG, { harness: "codex" })).some((error) => /models\.default.*codex harness/.test(error)),
  );
  assert.ok(
    validateConfig(
      mergeConfig(DEFAULT_CONFIG, {
        harness: "codex",
        models: { default: "codex/gpt-fixture" },
        budgets: { run: { cost: 1 } },
      }),
    ).some((error) => /cost is unavailable for the codex harness/.test(error)),
  );
});
