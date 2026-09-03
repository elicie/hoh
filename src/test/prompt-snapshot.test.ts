import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createDemoMockHarness, MockHarness } from "../harness/mock.js";
import { commitAll, git, RUNTIME_IDENTITY } from "../runtime/git.js";
import { runHoh } from "../runtime/loop.js";
import { buildPromptSnapshot, combinedPromptInputSha256 } from "../runtime/prompt-snapshot.js";
import { REDACTION_MARKER } from "../runtime/redaction.js";
import { readJson, RunPaths, writeJson } from "../runtime/state.js";
import type { Role, RolePromptSnapshot, StoredPromptFieldMetadata } from "../types.js";
import { makeWorkspace } from "./helpers.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function lastTranscriptInvocation(paths: RunPaths, loopIndex: number, role: Role): Promise<{ systemPrompt: string; prompt: string }> {
  const entries = (await readFile(paths.transcript(loopIndex, role), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { systemPrompt: string; prompt: string });
  return entries.at(-1)!;
}

function assertUnredactedStorage(metadata: StoredPromptFieldMetadata, storedPrompt: string): void {
  assert.equal(metadata.stored_sha256, sha256(storedPrompt));
  assert.equal(metadata.redacted, false);
  assert.equal(metadata.replacement_count, 0);
  assert.deepEqual(
    metadata.rules.map((rule) => [rule.id, rule.count]),
    [
      ["authorization-header", 0],
      ["json-credential-field", 0],
      ["url-userinfo", 0],
      ["url-query-credential", 0],
      ["explicit-secret-value", 0],
    ],
  );
}

test("final role prompt snapshots use the v2 storage contract and retain exact hashes", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness: createDemoMockHarness(),
      config: { harness: "mock", loops: 1 },
    });
    const paths = new RunPaths(ws);

    for (const role of ["planner", "developer", "tester"] as const) {
      const snapshot = (await readJson<RolePromptSnapshot>(paths.promptSnapshot(1, role)))!;
      const invocation = await lastTranscriptInvocation(paths, 1, role);
      assert.equal(snapshot.schema_version, 2);
      assert.equal(snapshot.role, role);
      assert.equal(snapshot.loop_index, 1);
      assert.equal(snapshot.final_attempt, 1);
      assert.equal(snapshot.system_prompt, invocation.systemPrompt);
      assert.equal(snapshot.user_prompt, invocation.prompt);
      assert.equal(snapshot.system_prompt_sha256, sha256(snapshot.system_prompt));
      assert.equal(snapshot.user_prompt_sha256, sha256(snapshot.user_prompt));
      assert.equal(snapshot.combined_input_sha256, sha256(JSON.stringify([snapshot.system_prompt, snapshot.user_prompt])));
      assert.equal(snapshot.combined_input_sha256, combinedPromptInputSha256(snapshot.system_prompt, snapshot.user_prompt));
      assertUnredactedStorage(snapshot.system_prompt_storage, snapshot.system_prompt);
      assertUnredactedStorage(snapshot.user_prompt_storage, snapshot.user_prompt);
      assert.ok(Number.isFinite(Date.parse(snapshot.created_at)));
    }

    const developerSnapshotAtCandidate = await git(
      ["cat-file", "-e", `${result.results[0].developer.candidate_commit_sha}:${paths.rel(paths.promptSnapshot(1, "developer"))}`],
      ws,
      { allowFail: true },
    );
    assert.notEqual(developerSnapshotAtCandidate.code, 0, "the runtime snapshot must be committed only after the candidate is frozen");
  } finally {
    await cleanup();
  }
});

test("builder hashes exact inputs but stores only redacted prompt copies and non-secret metadata", () => {
  const secretName = "PRIVATE_PROMPT_TOKEN_NAME";
  const secretValue = "private-prompt-token-value-12345";
  const contextualSecret = "short";
  const systemPrompt = `system ${secretValue} ${secretValue}`;
  const userPrompt = `{"password":"${contextualSecret}"}\nuser ${secretValue}`;
  const explicitSecrets = Object.freeze({ [secretName]: secretValue });

  const snapshot = buildPromptSnapshot({
    role: "planner",
    loopIndex: 3,
    finalAttempt: 2,
    systemPrompt,
    userPrompt,
    explicitSecrets,
    createdAt: "2026-09-03T00:00:00.000Z",
  });
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.schema_version, 2);
  assert.equal(snapshot.system_prompt, `system ${REDACTION_MARKER} ${REDACTION_MARKER}`);
  assert.equal(snapshot.user_prompt, `{"password":"${REDACTION_MARKER}"}\nuser ${REDACTION_MARKER}`);
  assert.equal(snapshot.system_prompt_sha256, sha256(systemPrompt));
  assert.equal(snapshot.user_prompt_sha256, sha256(userPrompt));
  assert.equal(snapshot.combined_input_sha256, combinedPromptInputSha256(systemPrompt, userPrompt));
  assert.notEqual(
    snapshot.combined_input_sha256,
    combinedPromptInputSha256(snapshot.system_prompt, snapshot.user_prompt),
    "the combined input hash must not be recomputed from storage-redacted strings",
  );
  assert.equal(snapshot.system_prompt_storage.stored_sha256, sha256(snapshot.system_prompt));
  assert.equal(snapshot.user_prompt_storage.stored_sha256, sha256(snapshot.user_prompt));
  assert.equal(snapshot.system_prompt_storage.redacted, true);
  assert.equal(snapshot.user_prompt_storage.redacted, true);
  assert.equal(snapshot.system_prompt_storage.replacement_count, 2);
  assert.equal(snapshot.user_prompt_storage.replacement_count, 2);
  assert.equal(
    snapshot.system_prompt_storage.rules.find((rule) => rule.id === "explicit-secret-value")?.count,
    2,
  );
  assert.equal(
    snapshot.user_prompt_storage.rules.find((rule) => rule.id === "json-credential-field")?.count,
    1,
  );
  assert.equal(
    snapshot.user_prompt_storage.rules.find((rule) => rule.id === "explicit-secret-value")?.count,
    1,
  );
  assert.ok(!serialized.includes(secretValue));
  assert.ok(!serialized.includes(contextualSecret));
  assert.ok(!serialized.includes(secretName));
  assert.deepEqual(explicitSecrets, { [secretName]: secretValue });

  const arraySnapshot = buildPromptSnapshot({
    role: "planner",
    loopIndex: 3,
    finalAttempt: 2,
    systemPrompt,
    userPrompt,
    explicitSecrets: [null, secretValue, undefined],
    createdAt: "2026-09-03T00:00:00.000Z",
  });
  assert.deepEqual(arraySnapshot, snapshot);
});

test("a structured-output retry snapshots the actual final prompt with its runtime notice", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const demo = createDemoMockHarness();
    let plannerAttempts = 0;
    const harness = new MockHarness({
      planner: (inv, api) => {
        plannerAttempts += 1;
        if (plannerAttempts === 1) return "No structured plan yet.";
        return demo["scripts"].planner!(inv, api);
      },
      developer: (inv, api) => demo["scripts"].developer!(inv, api),
      tester: (inv, api) => demo["scripts"].tester!(inv, api),
    });

    await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } });
    const snapshot = (await readJson<RolePromptSnapshot>(new RunPaths(ws).promptSnapshot(1, "planner")))!;
    const calls = harness.calls.filter((call) => call.role === "planner" && call.loopIndex === 1);

    assert.equal(snapshot.final_attempt, 2);
    assert.equal(snapshot.user_prompt, calls[1].prompt);
    assert.match(snapshot.user_prompt, /## Runtime notice/);
    assert.match(snapshot.user_prompt, /submit_development_document/);
    assert.equal(snapshot.user_prompt_sha256, sha256(calls[1].prompt));
  } finally {
    await cleanup();
  }
});

test("mid-loop resume preserves completed-role snapshots and overwrites the rerun Tester snapshot", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const demo = createDemoMockHarness();
    const crashing = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: (inv, api) => demo["scripts"].developer!(inv, api),
      tester: () => {
        throw new Error("tester transport failed");
      },
    });
    await assert.rejects(
      runHoh({ workspace: ws, specPath: spec, harness: crashing, config: { harness: "mock", loops: 1 } }),
      /tester transport failed/,
    );

    const paths = new RunPaths(ws);
    const plannerBefore = (await readJson<RolePromptSnapshot>(paths.promptSnapshot(1, "planner")))!;
    const developerBefore = (await readJson<RolePromptSnapshot>(paths.promptSnapshot(1, "developer")))!;
    await writeJson(paths.promptSnapshot(1, "tester"), { stale: true });
    await commitAll(ws, "test: seed stale tester prompt snapshot", RUNTIME_IDENTITY, [paths.rel(paths.promptSnapshot(1, "tester"))]);

    const healthyDemo = createDemoMockHarness();
    const healthy = new MockHarness({ tester: (inv, api) => healthyDemo["scripts"].tester!(inv, api) });
    await runHoh({ workspace: ws, harness: healthy });

    assert.deepEqual(await readJson(paths.promptSnapshot(1, "planner")), plannerBefore);
    assert.deepEqual(await readJson(paths.promptSnapshot(1, "developer")), developerBefore);
    const testerAfter = (await readJson<RolePromptSnapshot>(paths.promptSnapshot(1, "tester")))!;
    assert.equal(testerAfter.role, "tester");
    assert.equal(testerAfter.final_attempt, 1);
    assert.equal(testerAfter.user_prompt, healthy.calls[0].prompt);
    assert.equal((testerAfter as unknown as { stale?: boolean }).stale, undefined);
  } finally {
    await cleanup();
  }
});

test("unknown external evaluator metadata in a previous record is not mixed into next-loop rendered prompts", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const firstHarness = createDemoMockHarness();
    await runHoh({ workspace: ws, specPath: spec, harness: firstHarness, config: { harness: "mock", loops: 1 } });

    const paths = new RunPaths(ws);
    const sentinel = "EXTERNAL_EVALUATOR_SENTINEL_7f4d2b";
    const previousEvidence = (await readJson<Record<string, unknown>>(paths.evidenceJson(1)))!;
    previousEvidence.external_evaluator = { note: sentinel };
    await writeJson(paths.evidenceJson(1), previousEvidence);
    await commitAll(ws, "test: attach external evaluator metadata", RUNTIME_IDENTITY, [paths.rel(paths.evidenceJson(1))]);

    const nextHarness = createDemoMockHarness();
    await runHoh({ workspace: ws, harness: nextHarness, config: { loops: 2 } });

    const loopTwoCalls = nextHarness.calls.filter((call) => call.loopIndex === 2);
    assert.deepEqual(
      loopTwoCalls.map((call) => call.role),
      ["planner", "developer", "tester"],
    );
    for (const call of loopTwoCalls) assert.doesNotMatch(call.prompt, new RegExp(sentinel));
    for (const role of ["planner", "developer", "tester"] as const) {
      const snapshot = (await readJson<RolePromptSnapshot>(paths.promptSnapshot(2, role)))!;
      assert.doesNotMatch(snapshot.system_prompt, new RegExp(sentinel));
      assert.doesNotMatch(snapshot.user_prompt, new RegExp(sentinel));
    }
    const retainedEvidence = (await readJson<Record<string, unknown>>(paths.evidenceJson(1)))!;
    assert.equal((retainedEvidence.external_evaluator as { note: string }).note, sentinel);
  } finally {
    await cleanup();
  }
});
