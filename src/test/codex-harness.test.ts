import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { CodexHarness, detectCodexVersion } from "../harness/codex.js";
import { createHarness } from "../harness/factory.js";
import type { RoleInvocation } from "../harness/types.js";
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from "../runtime/config.js";
import { runHoh } from "../runtime/loop.js";
import { buildProtocolReceipt } from "../runtime/protocol.js";
import { readJson, RunPaths } from "../runtime/state.js";
import type { RolePromptSnapshot } from "../types.js";
import { testerTools } from "../runtime/schemas.js";
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
      env: { FAKE_CODEX_RECORD: record, FAKE_CODEX_NULL_OPTIONALS: "1" },
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
      structuredTools: [
        {
          name: "submit_fixture",
          description: "fixture",
          parameters: Type.Object({
            ok: Type.Boolean(),
            detail: Type.Object({
              required: Type.String({ minLength: 1, pattern: "^fixture" }),
              optional: Type.Optional(Type.String()),
              tags: Type.Array(Type.String(), { minItems: 1, maxItems: 2, uniqueItems: true }),
            }),
          }),
        },
      ],
      model: "codex/gpt-fixture:high",
      onTranscript: (chunk) => transcript.push(chunk),
    });
    assert.deepEqual(result.submissions.submit_fixture, [
      { ok: true, detail: { required: "fixture-value", tags: ["fixture-value"] } },
    ]);
    assert.deepEqual(result.usage, { input: 120, output: 30, cacheRead: 20, cacheWrite: 0, totalTokens: 150, cost: 0 });
    assert.equal(result.turns, 1);
    assert.equal(result.model, undefined);
    const invocation = JSON.parse(await readFile(record, "utf8"));
    assert.equal(invocation.prompt, "USER PROMPT SENTINEL");
    assert.ok(invocation.args.includes("--ephemeral"));
    assert.ok(invocation.args.includes("--ignore-user-config"));
    assert.ok(invocation.args.includes("--ignore-rules"));
    assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "read-only");
    assert.ok(invocation.args.includes('developer_instructions="SYSTEM CONTRACT SENTINEL"'));
    assert.ok(invocation.args.includes('model_reasoning_effort="high"'));
    assert.equal(invocation.outputSchema.additionalProperties, false);
    assert.deepEqual(invocation.outputSchema.required, ["ok", "detail"]);
    assert.equal(invocation.outputSchema.properties.detail.additionalProperties, false);
    assert.deepEqual(invocation.outputSchema.properties.detail.required, ["required", "optional", "tags"]);
    assert.ok(invocation.outputSchema.properties.detail.properties.optional.anyOf.some((candidate: { type?: string }) => candidate.type === "null"));
    assert.doesNotMatch(JSON.stringify(invocation.outputSchema), /"uniqueItems"/);
    assert.equal(invocation.outputSchema.properties.detail.properties.required.minLength, 1);
    assert.equal(invocation.outputSchema.properties.detail.properties.required.pattern, "^fixture");
    assert.equal(invocation.outputSchema.properties.detail.properties.tags.minItems, 1);
    assert.equal(invocation.outputSchema.properties.detail.properties.tags.maxItems, 2);
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

test("Codex QA grants the external evidence directory and captures real command files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hoh-codex-evidence-"));
  try {
    const cwd = path.join(directory, "candidate");
    const evidenceDir = path.join(directory, "evidence");
    const record = path.join(directory, "invocation.json");
    await mkdir(cwd);
    await mkdir(evidenceDir);
    await writeFile(path.join(cwd, "input.txt"), "actual artifact output\n");
    const harness = new CodexHarness({ executable: process.execPath, executableArgs: [fixture], env: {
      FAKE_CODEX_RECORD: record, FAKE_CODEX_EXECUTE: "1", HOH_EVIDENCE_DIR: evidenceDir,
    } });
    const inv: RoleInvocation = {
      role: "tester" as const, loopIndex: 1, cwd, evidenceDir,
      systemPrompt: "Output contract: you MUST call the `submit_evidence` tool exactly once.",
      prompt: "Inspect then call `submit_evidence`. Your previous attempt ended without calling `submit_evidence`. The runtime only accepts output delivered through that tool.",
      tools: ["read", "bash", "grep", "find", "ls"], structuredTools: testerTools, model: "codex/gpt-fixture",
    };
    const prepared = harness.preparePrompts(inv);
    assert.deepEqual(harness.preparePrompts({ ...inv, ...prepared }), prepared);
    const result = await harness.invoke(inv);
    const invocation = JSON.parse(await readFile(record, "utf8"));
    assert.equal(invocation.args[invocation.args.indexOf("--add-dir") + 1], evidenceDir);
    assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(invocation.prompt, prepared.prompt);
    assert.ok(invocation.args.includes(`developer_instructions=${JSON.stringify(prepared.systemPrompt)}`));
    assert.doesNotMatch(prepared.systemPrompt + prepared.prompt, /call(?:ing)? (?:the )?`submit_/i);
    assert.equal(result.executions?.length, 1);
    const execution = result.executions![0];
    assert.equal(execution.exit_code, 0);
    assert.match(execution.command, /test -s input.txt/);
    assert.deepEqual(execution.files, [{ path: "qa/result.log", sha256: createHash("sha256").update("actual artifact output\n").digest("hex") }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
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

test("codex rejects paper without reported model identity and runs extended with its native policy", async () => {
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

    await assert.rejects(buildProtocolReceipt(config, harness, { legacyDefault: false, origin: "run_start" }), /cannot report its actual execution model/);
    config.protocol = "extended";
    const receipt = await buildProtocolReceipt(config, harness, { legacyDefault: false, origin: "run_start" });
    assert.deepEqual(receipt.models, {
      planner: null,
      developer: null,
      tester: null,
    });
    assert.deepEqual(receipt.role_contracts.planner.builtin_tools, ["codex-exec:read-only"]);
    assert.deepEqual(receipt.role_contracts.developer.builtin_tools, ["codex-exec:workspace-write"]);
    assert.deepEqual(receipt.role_contracts.tester.builtin_tools, ["codex-exec:workspace-write-on-frozen-copy"]);

    const result = await runHoh({ workspace: ws, specPath: spec, harness, config });
    assert.equal(result.status, "completed");
    assert.equal(result.results.length, 1);
    assert.equal(result.run.protocol_receipt?.harness.name, "codex");
    assert.equal(result.results[0].planner.usage.model, undefined);
    assert.equal(result.results[0].evidence.usage.model, undefined);
    const snapshot = (await readJson<RolePromptSnapshot>(new RunPaths(ws).promptSnapshot(1, "tester")))!;
    assert.match(snapshot.system_prompt, /final JSON object/);
    assert.doesNotMatch(snapshot.system_prompt + snapshot.user_prompt, /call(?:ing)? `submit_/i);
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
