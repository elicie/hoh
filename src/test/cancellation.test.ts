import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createDemoMockHarness, MockHarness } from "../harness/mock.js";
import { withInvocationDeadline } from "../harness/pi.js";
import type { Harness } from "../harness/types.js";
import { emptyUsage } from "../harness/types.js";
import { runCheck } from "../runtime/checks.js";
import { ensureClaimState } from "../runtime/claims.js";
import { git } from "../runtime/git.js";
import { verifyCurrentRunReceipt } from "../runtime/run-receipt.js";
import { runHoh } from "../runtime/loop.js";
import { readJson, RunPaths } from "../runtime/state.js";
import type { EvidenceBundle } from "../types.js";
import { makeWorkspace } from "./helpers.js";

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function cancellationReason(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

test("cancellation: Pi deadline waits for abort cleanup and preserves the operator reason", async () => {
  const controller = new AbortController();
  const reason = cancellationReason("cancel Pi");
  let resolveOperation!: (value: string) => void;
  const operation = new Promise<string>((resolve) => {
    resolveOperation = resolve;
  });
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  let abortStarted = false;
  let abortFinished = false;
  let observed: "pending" | "resolved" | "rejected" = "pending";
  const pending = withInvocationDeadline(
    () => operation,
    undefined,
    controller.signal,
    async () => {
      abortStarted = true;
      await abortGate;
      abortFinished = true;
      throw new Error("SDK abort cleanup failed");
    },
  );
  void pending.then(
    () => {
      observed = "resolved";
    },
    () => {
      observed = "rejected";
    },
  );

  controller.abort(reason);
  resolveOperation("late success");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(abortStarted, true);
  assert.equal(observed, "pending", "the original prompt result must not win after cancellation starts");

  releaseAbort();
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(abortFinished, true, "session disposal may proceed only after abort cleanup has finished");
  assert.equal(observed, "rejected");
});

test("cancellation: aborting a deterministic check kills its whole process group", async () => {
  const { ws, cleanup } = await makeWorkspace();
  const marker = path.join(ws, "late-check-write.txt");
  const controller = new AbortController();
  const reason = cancellationReason("stop the check");

  try {
    const pending = runCheck(
      { name: "long-check", command: '(sleep 0.4; printf late > "$CANCEL_MARKER") & wait' },
      ws,
      10_000,
      { CANCEL_MARKER: marker },
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(reason), 50);
    await assert.rejects(pending, (error) => error === reason);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await exists(marker), false, "a grandchild must not survive cancellation and write later");
  } finally {
    await cleanup();
  }
});

test("cancellation: claim drafting rechecks an ignored signal before persisting the catalog", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  const paths = new RunPaths(ws);
  const controller = new AbortController();
  const reason = cancellationReason("stop claim drafting");
  const harness: Harness = {
    name: "mock",
    version: "cancellation-fixture",
    resolveModel: async () => "mock",
    invoke: async () => {
      controller.abort(reason);
      return {
        finalText: "",
        submissions: {
          submit_claims: [
            {
              claims: [{ id: "entry", criterion: "The entry works.", requires: ["check"] }],
            },
          ],
        },
        usage: emptyUsage(),
        turns: 1,
        model: "mock",
      };
    },
  };

  try {
    await rm(paths.claims, { force: true });
    await assert.rejects(
      ensureClaimState({
        mode: "generate",
        workspace: ws,
        specPath: spec,
        spec: await readFile(spec, "utf8"),
        harness,
        paths,
        signal: controller.signal,
      }),
      (error) => error === reason,
    );
    assert.equal(await readJson(paths.claims), null);
  } finally {
    await cleanup();
  }
});

test("cancellation: stopping Tester removes the QA worktree without recording a QA or runtime failure", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  const controller = new AbortController();
  const reason = cancellationReason("operator requested stop");
  const demo = createDemoMockHarness();
  const logs: string[] = [];
  const paths = new RunPaths(ws);
  let receiptBeforeAbort = "";
  const harness = new MockHarness({
    planner: (inv, api) => demo["scripts"].planner!(inv, api),
    developer: (inv, api) => demo["scripts"].developer!(inv, api),
    tester: async (inv) => {
      receiptBeforeAbort = await readFile(paths.receipt, "utf8");
      controller.abort(reason);
      inv.signal?.throwIfAborted();
    },
  });

  try {
    await assert.rejects(
      runHoh({
        workspace: ws,
        specPath: spec,
        harness,
        config: { harness: "mock", loops: 1 },
        signal: controller.signal,
        log: (message) => logs.push(message),
      }),
      (error) => error === reason,
    );

    assert.equal(await readJson<EvidenceBundle>(paths.evidenceJson(1)), null, "cancelled Tester must not emit a QA verdict");
    assert.equal(await exists(paths.errorJson(1)), false, "operator cancellation is not a runtime failure");
    const worktrees = await git(["worktree", "list"], ws);
    assert.equal(worktrees.stdout.trim().split("\n").length, 1, worktrees.stdout);
    const latest = await git(["log", "-1", "--format=%s"], ws);
    assert.doesNotMatch(latest.stdout, /runtime error/);
    const history = await git(["log", "--format=%s"], ws);
    assert.doesNotMatch(history.stdout, /checkpoint failed run receipt/);
    assert.notEqual(await readFile(paths.receipt, "utf8"), receiptBeforeAbort);
    assert.equal((await verifyCurrentRunReceipt(ws)).ok, true, "cancellation must leave a verifiable checkpoint");
    assert.ok(logs.some((message) => /CANCELLED operator requested stop/.test(message)));
    assert.equal(process.env.HOH_CANDIDATE_DIR, undefined);
    assert.equal(process.env.HOH_EVIDENCE_DIR, undefined);
    assert.equal(await readFile(paths.developerJson(1), "utf8").then(Boolean), true, "the frozen Developer candidate remains resumable");
    const resumed = await runHoh({ workspace: ws, harness: demo });
    assert.equal(resumed.results.length, 1);
    assert.equal((await verifyCurrentRunReceipt(ws)).ok, true);
  } finally {
    await cleanup();
  }
});

test("cancellation: a stop during Tester post-processing cannot persist a verdict", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  const controller = new AbortController();
  const reason = cancellationReason("stop QA post-processing");
  const demo = createDemoMockHarness();
  const harness = new MockHarness({
    planner: (inv, api) => demo["scripts"].planner!(inv, api),
    developer: (inv, api) => demo["scripts"].developer!(inv, api),
    tester: async (inv, api) => {
      const text = await demo["scripts"].tester!(inv, api);
      setTimeout(() => controller.abort(reason), 0);
      return text;
    },
  });

  try {
    await assert.rejects(
      runHoh({
        workspace: ws,
        specPath: spec,
        harness,
        config: { harness: "mock", loops: 1 },
        signal: controller.signal,
      }),
      (error) => error === reason,
    );
    const paths = new RunPaths(ws);
    assert.equal(await readJson<EvidenceBundle>(paths.evidenceJson(1)), null);
    assert.equal(await exists(paths.errorJson(1)), false);
    const worktrees = await git(["worktree", "list"], ws);
    assert.equal(worktrees.stdout.trim().split("\n").length, 1, worktrees.stdout);
  } finally {
    await cleanup();
  }
});
