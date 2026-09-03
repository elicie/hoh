import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addExperimentAttempt,
  createExperimentManifest,
  type ExperimentAttemptOutcome,
  type ExperimentPlan,
  parseExperimentManifest,
} from "../experiment/manifest.js";
import { canonicalSha256 } from "../runtime/protocol.js";

const RUBRIC_SHA = "a".repeat(64);
const RUN_SHA = "b".repeat(64);

function plan(): ExperimentPlan {
  return {
    samples: [
      { task_id: "benchmark-task", sample_id: "sample-001" },
      { task_id: "benchmark-task", sample_id: "sample-002" },
    ],
    repetitions: 3,
    assignment_seed: 42,
    cells: [
      { id: "cell-hoh", condition: "hoh" },
      { id: "cell-vanilla", condition: "vanilla" },
      { id: "cell-no-plan", condition: "no-plan-update" },
      { id: "cell-no-evidence", condition: "no-evidence" },
      { id: "cell-no-warm-start", condition: "no-warm-start" },
    ],
    budget: { unit: "wall_clock_ms", limit: 120_000 },
    evaluator: {
      argv: ["/opt/benchmark/evaluate", "--format", "json"],
      version: "benchmark-evaluator@1.2.3",
      rubric_sha256: RUBRIC_SHA,
    },
    metric: "task_success_rate",
    aggregation: "macro_mean",
    uncertainty: "bootstrap_95_ci",
    exclusion_rules: ["exclude only pre-registered infrastructure failures"],
    retry: { max_attempts: 2, retryable_failure_codes: ["provider_transport"] },
  };
}

function firstAttempt(planSha256: string): ExperimentAttemptOutcome {
  return {
    plan_sha256: planSha256,
    attempt_id: "attempt-001",
    cell_id: "cell-hoh",
    task_id: "benchmark-task",
    sample_id: "sample-001",
    repetition: 1,
    retry: { attempt: 1, retry_of: null },
    run_receipt_sha256: RUN_SHA,
    status: "failed",
    failure: { code: "provider_transport", message: "connection reset" },
    valid: false,
    invalid_reason: "pre-registered transport exclusion",
  };
}

test("experiment manifest: canonical plan is detached, deeply frozen, and unchanged by outcomes", () => {
  const input = plan();
  const manifest = createExperimentManifest(input);

  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.plan_sha256, canonicalSha256(manifest.plan));
  assert.deepEqual(manifest.attempts, []);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.plan), true);
  assert.equal(Object.isFrozen(manifest.plan.cells), true);
  assert.equal(Object.isFrozen(manifest.plan.evaluator.argv), true);

  (input.samples[0] as { sample_id: string }).sample_id = "mutated-source";
  assert.equal(manifest.plan.samples[0].sample_id, "sample-001", "creation must detach the immutable plan from caller-owned input");
  assert.throws(() => {
    (manifest.plan as { metric: string }).metric = "changed-after-freeze";
  }, TypeError);

  const withFailure = addExperimentAttempt(manifest, firstAttempt(manifest.plan_sha256));
  assert.equal(manifest.attempts.length, 0, "adding an outcome must not mutate the previous manifest");
  assert.equal(withFailure.attempts.length, 1);
  assert.equal(withFailure.plan_sha256, manifest.plan_sha256);
  assert.deepEqual(withFailure.plan, manifest.plan);

  const recovered: ExperimentAttemptOutcome = {
    ...firstAttempt(manifest.plan_sha256),
    attempt_id: "attempt-002",
    retry: { attempt: 2, retry_of: "attempt-001" },
    run_receipt_sha256: "c".repeat(64),
    status: "completed",
    failure: null,
    valid: true,
    invalid_reason: null,
  };
  const withRetry = addExperimentAttempt(withFailure, recovered);
  assert.deepEqual(withRetry.attempts.map((attempt) => attempt.attempt_id), ["attempt-001", "attempt-002"]);
  assert.ok(withRetry.attempts.every((attempt) => attempt.plan_sha256 === manifest.plan_sha256));

  const tampered = structuredClone(withRetry) as unknown as { plan: { metric: string } };
  tampered.plan.metric = "post-hoc metric";
  assert.throws(() => parseExperimentManifest(tampered), /plan_sha256 does not match the canonical plan/);
});

test("experiment manifest: plan validation fixes conditions, argv, hashes, repetitions, seed, and common budget", () => {
  const badCases: Array<{ mutate: (value: any) => void; error: RegExp }> = [
    { mutate: (value) => (value.repetitions = 0), error: /plan\.repetitions must be a positive safe integer/ },
    { mutate: (value) => (value.assignment_seed = -1), error: /plan\.assignment_seed must be a non-negative safe integer/ },
    { mutate: (value) => (value.assignment_seed = 1.5), error: /plan\.assignment_seed must be a non-negative safe integer/ },
    { mutate: (value) => (value.budget.limit = 0), error: /plan\.budget\.limit must be a finite number greater than zero/ },
    { mutate: (value) => (value.budget.limit = 1.5), error: /positive safe integer for wall_clock_ms/ },
    { mutate: (value) => (value.evaluator.argv = []), error: /plan\.evaluator\.argv must be a non-empty argv array/ },
    { mutate: (value) => (value.evaluator.argv = "evaluate --json"), error: /plan\.evaluator\.argv must be a non-empty argv array/ },
    { mutate: (value) => (value.evaluator.rubric_sha256 = "ABC"), error: /rubric_sha256 must be a lowercase 64-character/ },
    { mutate: (value) => value.cells.pop(), error: /must contain exactly one cell for each condition/ },
    { mutate: (value) => (value.cells[4].condition = "hoh"), error: /duplicates condition "hoh"/ },
  ];

  for (const { mutate, error } of badCases) {
    const value = structuredClone(plan());
    mutate(value);
    assert.throws(() => createExperimentManifest(value), error);
  }
});

test("experiment manifest: outcomes must reference the frozen plan and obey retry and validity rules", () => {
  const manifest = createExperimentManifest(plan());
  const base = firstAttempt(manifest.plan_sha256);

  assert.throws(
    () => addExperimentAttempt(manifest, { ...base, plan_sha256: "d".repeat(64) }),
    /attempt\.plan_sha256 must equal manifest\.plan_sha256/,
  );
  assert.throws(
    () => addExperimentAttempt(manifest, { ...base, run_receipt_sha256: "not-a-hash" }),
    /run_receipt_sha256 must be a lowercase 64-character/,
  );
  assert.throws(
    () => addExperimentAttempt(manifest, { ...base, repetition: 4 }),
    /must not exceed plan\.repetitions/,
  );
  assert.throws(
    () => addExperimentAttempt(manifest, { ...base, status: "completed", failure: null, valid: false, invalid_reason: null }),
    /invalid_reason is required for an invalid attempt/,
  );

  const withFailure = addExperimentAttempt(manifest, base);
  assert.throws(
    () =>
      addExperimentAttempt(withFailure, {
        ...base,
        attempt_id: "attempt-002",
        retry: { attempt: 2, retry_of: "missing-attempt" },
      }),
    /must reference attempt N-1 for the same cell\/task\/sample\/repetition/,
  );

  const nonRetryable = addExperimentAttempt(manifest, {
    ...base,
    failure: { code: "model_quality", message: "valid model result did not pass" },
  });
  assert.throws(
    () =>
      addExperimentAttempt(nonRetryable, {
        ...base,
        attempt_id: "attempt-002",
        retry: { attempt: 2, retry_of: "attempt-001" },
      }),
    /prior failure code "model_quality" is not retryable/,
  );
});
