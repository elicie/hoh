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
const EXECUTABLE_SHA = "c".repeat(64);
const CONFIG_SHA = "d".repeat(64);
const CONDITION_SHA = "e".repeat(64);
const EVALUATOR_RECEIPT_SHA = "f".repeat(64);
const WORKSPACE_TREE_OID = "1".repeat(40);
const ARTIFACT_TREE_OID = "2".repeat(40);
const PROTOCOL_SHA_BY_CONDITION = {
  hoh: "3".repeat(64),
  vanilla: "4".repeat(64),
  "no-plan-update": "5".repeat(64),
  "no-evidence": "6".repeat(64),
  "no-warm-start": "7".repeat(64),
} as const;
const EXCLUSION = "provider_transport";

function plan(): ExperimentPlan {
  return {
    execution: {
      config_sha256: CONFIG_SHA,
      loops: 3,
      artifact_dir: "game",
      artifact_packager: "git-archive-tar-v1",
      harness: { name: "codex", version: "codex-cli 1.2.3" },
      resolved_model: "gpt-5.6-codex/high",
      condition_policy_version: "arxiv:2609.01481v1/conditions-v1",
    },
    samples: [
      {
        task_id: "benchmark-task",
        sample_id: "sample-001",
        spec_sha256: "8".repeat(64),
        evaluator_task_sha256: "9".repeat(64),
        evaluator_sample_sha256: "a".repeat(64),
        a0: { workspace_tree_oid: WORKSPACE_TREE_OID, artifact_tree_oid: ARTIFACT_TREE_OID },
      },
      {
        task_id: "benchmark-task",
        sample_id: "sample-002",
        spec_sha256: "b".repeat(64),
        evaluator_task_sha256: "c".repeat(64),
        evaluator_sample_sha256: "d".repeat(64),
        a0: { workspace_tree_oid: "3".repeat(40), artifact_tree_oid: "4".repeat(40) },
      },
    ],
    repetitions: 3,
    assignment_seed: 42,
    cells: [
      { id: "cell-hoh", condition: "hoh", protocol_sha256: PROTOCOL_SHA_BY_CONDITION.hoh },
      { id: "cell-vanilla", condition: "vanilla", protocol_sha256: PROTOCOL_SHA_BY_CONDITION.vanilla },
      { id: "cell-no-plan", condition: "no-plan-update", protocol_sha256: PROTOCOL_SHA_BY_CONDITION["no-plan-update"] },
      { id: "cell-no-evidence", condition: "no-evidence", protocol_sha256: PROTOCOL_SHA_BY_CONDITION["no-evidence"] },
      { id: "cell-no-warm-start", condition: "no-warm-start", protocol_sha256: PROTOCOL_SHA_BY_CONDITION["no-warm-start"] },
    ],
    budget: { unit: "wall_clock_ms", limit: 120_000 },
    evaluator: {
      argv: ["/opt/benchmark/evaluate", "--format", "json"],
      version: "benchmark-evaluator@1.2.3",
      rubric_sha256: RUBRIC_SHA,
      executable_sha256: EXECUTABLE_SHA,
    },
    metric: "task_success_rate",
    aggregation: "macro_mean",
    uncertainty: "bootstrap_95_ci",
    exclusion_rules: [EXCLUSION, "model_quality"],
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
    condition_contract_sha256: CONDITION_SHA,
    protocol_receipt_sha256: PROTOCOL_SHA_BY_CONDITION.hoh,
    evaluator_receipt_sha256: null,
    status: "failed",
    failure: { code: "provider_transport", message: "connection reset" },
    valid: false,
    invalid_reason: EXCLUSION,
  };
}

test("experiment manifest: canonical plan is detached, deeply frozen, and unchanged by outcomes", () => {
  const input = plan();
  const manifest = createExperimentManifest(input);

  assert.equal(manifest.schema_version, 2);
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
    evaluator_receipt_sha256: EVALUATOR_RECEIPT_SHA,
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
    { mutate: (value) => (value.execution.config_sha256 = "bad"), error: /execution\.config_sha256 must be a lowercase 64-character/ },
    { mutate: (value) => (value.execution.loops = 0), error: /execution\.loops must be a positive safe integer/ },
    { mutate: (value) => (value.execution.artifact_dir = "../escape"), error: /artifact_dir must be a canonical POSIX/ },
    { mutate: (value) => (value.execution.artifact_dir = ".hoh/private"), error: /artifact_dir must be a canonical POSIX/ },
    { mutate: (value) => (value.execution.artifact_dir = ".git/objects"), error: /artifact_dir must be a canonical POSIX/ },
    { mutate: (value) => (value.execution.artifact_packager = "zip-v1"), error: /artifact_packager must be exactly "git-archive-tar-v1"/ },
    { mutate: (value) => (value.execution.harness.version = " "), error: /harness\.version must be a non-empty string/ },
    { mutate: (value) => (value.execution.resolved_model = ""), error: /resolved_model must be a non-empty string/ },
    { mutate: (value) => delete value.samples[0].spec_sha256, error: /samples\[0\] is missing spec_sha256/ },
    { mutate: (value) => (value.samples[0].evaluator_task_sha256 = "bad"), error: /evaluator_task_sha256 must be a lowercase 64-character/ },
    { mutate: (value) => (value.samples[0].a0.workspace_tree_oid = "bad"), error: /workspace_tree_oid must be a full lowercase Git object ID/ },
    { mutate: (value) => (value.cells[0].protocol_sha256 = "bad"), error: /protocol_sha256 must be a lowercase 64-character/ },
    { mutate: (value) => (value.repetitions = 0), error: /plan\.repetitions must be a positive safe integer/ },
    { mutate: (value) => (value.assignment_seed = -1), error: /plan\.assignment_seed must be a non-negative safe integer/ },
    { mutate: (value) => (value.assignment_seed = 1.5), error: /plan\.assignment_seed must be a non-negative safe integer/ },
    { mutate: (value) => (value.budget.limit = 0), error: /plan\.budget\.limit must be a finite number greater than zero/ },
    { mutate: (value) => (value.budget.limit = 1.5), error: /positive safe integer for wall_clock_ms/ },
    { mutate: (value) => (value.evaluator.argv = []), error: /plan\.evaluator\.argv must contain 1-64 entries/ },
    { mutate: (value) => (value.evaluator.argv = "evaluate --json"), error: /plan\.evaluator\.argv must contain 1-64 entries/ },
    { mutate: (value) => (value.evaluator.argv = Array(65).fill("argument")), error: /plan\.evaluator\.argv must contain 1-64 entries/ },
    { mutate: (value) => (value.evaluator.argv = ["/" + "x".repeat(16_384)]), error: /argv must not exceed 16384 UTF-8 bytes/ },
    { mutate: (value) => (value.evaluator.version = "v".repeat(257)), error: /version must not exceed 256 UTF-8 bytes/ },
    { mutate: (value) => (value.evaluator.argv[0] = "evaluate"), error: /plan\.evaluator\.argv\[0\] must be an absolute executable path/ },
    { mutate: (value) => (value.evaluator.rubric_sha256 = "ABC"), error: /rubric_sha256 must be a lowercase 64-character/ },
    { mutate: (value) => (value.evaluator.executable_sha256 = "ABC"), error: /executable_sha256 must be a lowercase 64-character/ },
    { mutate: (value) => (value.aggregation = "mean"), error: /aggregation must be exactly "macro_mean"/ },
    { mutate: (value) => (value.uncertainty = "normal_95_ci"), error: /uncertainty must be exactly "bootstrap_95_ci"/ },
    { mutate: (value) => value.exclusion_rules.push(EXCLUSION), error: /exclusion_rules must not contain duplicates/ },
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
    () => addExperimentAttempt(manifest, { ...base, condition_contract_sha256: "not-a-hash" }),
    /condition_contract_sha256 must be a lowercase 64-character/,
  );
  assert.throws(
    () => addExperimentAttempt(manifest, { ...base, protocol_receipt_sha256: PROTOCOL_SHA_BY_CONDITION.vanilla }),
    /protocol_receipt_sha256 must equal cell protocol_sha256/,
  );
  assert.throws(
    () => addExperimentAttempt(manifest, { ...base, evaluator_receipt_sha256: "not-a-hash" }),
    /evaluator_receipt_sha256 must be a lowercase 64-character/,
  );
  assert.throws(
    () => addExperimentAttempt(manifest, { ...base, repetition: 4 }),
    /must not exceed plan\.repetitions/,
  );
  assert.throws(
    () => addExperimentAttempt(manifest, { ...base, status: "completed", failure: null, valid: false, invalid_reason: null }),
    /invalid_reason is required for an invalid attempt/,
  );
  assert.throws(
    () =>
      addExperimentAttempt(manifest, {
        ...base,
        status: "completed",
        failure: null,
        valid: true,
        invalid_reason: null,
        evaluator_receipt_sha256: null,
      }),
    /evaluator_receipt_sha256 is required for every completed or valid attempt/,
  );
  assert.throws(
    () => addExperimentAttempt(manifest, { ...base, invalid_reason: "post-hoc outlier" }),
    /must exactly match a pre-registered exclusion rule/,
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
    invalid_reason: "model_quality",
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

  const completedInvalid = addExperimentAttempt(manifest, {
    ...base,
    status: "completed",
    failure: null,
    evaluator_receipt_sha256: EVALUATOR_RECEIPT_SHA,
  });
  assert.equal(completedInvalid.attempts[0].invalid_reason, EXCLUSION);
  assert.equal(completedInvalid.attempts[0].evaluator_receipt_sha256, EVALUATOR_RECEIPT_SHA);
  const identicalReceiptRetry = addExperimentAttempt(completedInvalid, {
    ...completedInvalid.attempts[0],
    attempt_id: "identical-evaluator-receipt",
    cell_id: "cell-vanilla",
    protocol_receipt_sha256: PROTOCOL_SHA_BY_CONDITION.vanilla,
  });
  assert.equal(identicalReceiptRetry.attempts.length, 2, "blind receipts may be byte-identical across distinct attempts");
  assert.throws(
    () =>
      addExperimentAttempt(manifest, {
        ...base,
        failure: { code: "model_quality", message: "quality failure" },
      }),
    /invalid_reason must equal failure\.code/,
  );

  const legacy = structuredClone(manifest) as unknown as { schema_version: number };
  legacy.schema_version = 1;
  assert.throws(() => parseExperimentManifest(legacy), /manifest\.schema_version must be 2/);
});
