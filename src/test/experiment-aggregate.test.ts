import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as aggregateApi from "../experiment/aggregate.js";
import {
  aggregateExperimentResults,
  createRawExperimentResult,
  evaluatorReceiptSha256,
  parseRawExperimentResult,
  parseRawExperimentResultsJsonl,
  serializeExperimentAggregateSummary,
  serializeRawExperimentResultsJsonl,
  type EvaluatorReceiptSource,
  type RawExperimentResult,
} from "../experiment/aggregate.js";
import type { EvaluatorReceipt, JsonValue } from "../experiment/evaluator.js";
import {
  addExperimentAttempt,
  createExperimentManifest,
  EXPERIMENT_CONDITIONS,
  type ExperimentAttemptOutcome,
  type ExperimentManifest,
  type ExperimentPlan,
} from "../experiment/manifest.js";
import { canonicalJson, canonicalSha256 } from "../runtime/protocol.js";

const RUBRIC_SHA = sha("rubric");
const EXECUTABLE_SHA = sha("evaluator executable");
const PRIVATE_EVALUATOR_TEXT = "PRIVATE_EVALUATOR_STDOUT_AND_STDERR_MUST_NOT_BE_COPIED";

function plan(options: { samples?: number; repetitions?: number; seed?: number } = {}): ExperimentPlan {
  const sampleCount = options.samples ?? 3;
  return {
    execution: {
      config_sha256: sha("experiment config"),
      loops: 3,
      artifact_dir: "game",
      artifact_packager: "git-archive-tar-v1",
      harness: { name: "codex", version: "codex-cli 1.2.3" },
      resolved_model: "gpt-5.6-codex/high",
      condition_policy_version: "arxiv:2609.01481v1/conditions-v1",
    },
    samples: Array.from({ length: sampleCount }, (_, index) => ({
      task_id: "benchmark-task",
      sample_id: `sample-${index + 1}`,
      spec_sha256: sha(`spec:${index + 1}`),
      evaluator_task_sha256: sha(`evaluator-task:${index + 1}`),
      evaluator_sample_sha256: sha(`evaluator-sample:${index + 1}`),
      a0: {
        workspace_tree_oid: `${index + 1}`.repeat(40),
        artifact_tree_oid: `${index + 6}`.repeat(40),
      },
    })),
    repetitions: options.repetitions ?? 2,
    assignment_seed: options.seed ?? 42,
    cells: [
      { id: "cell-hoh", condition: "hoh", protocol_sha256: sha("protocol:hoh") },
      { id: "cell-vanilla", condition: "vanilla", protocol_sha256: sha("protocol:vanilla") },
      { id: "cell-no-plan", condition: "no-plan-update", protocol_sha256: sha("protocol:no-plan-update") },
      { id: "cell-no-evidence", condition: "no-evidence", protocol_sha256: sha("protocol:no-evidence") },
      { id: "cell-no-warm-start", condition: "no-warm-start", protocol_sha256: sha("protocol:no-warm-start") },
    ],
    budget: { unit: "total_tokens", limit: 100_000 },
    evaluator: {
      argv: ["/opt/benchmark/evaluate", "--json"],
      version: "benchmark-evaluator@1.0.0",
      rubric_sha256: RUBRIC_SHA,
      executable_sha256: EXECUTABLE_SHA,
    },
    metric: "task_success_rate",
    aggregation: "macro_mean",
    uncertainty: "bootstrap_95_ci",
    exclusion_rules: ["infrastructure_failure", "nonzero_exit"],
    retry: { max_attempts: 2, retryable_failure_codes: ["infrastructure_failure"] },
  };
}

function completedManifest(planValue = plan()): ExperimentManifest {
  let manifest = createExperimentManifest(planValue);
  for (const cell of manifest.plan.cells) {
    for (const sample of manifest.plan.samples) {
      for (let repetition = 1; repetition <= manifest.plan.repetitions; repetition += 1) {
        const attemptId = `${cell.id}-${sample.sample_id}-r${repetition}`;
        const receipt = successfulReceipt(manifest.plan, cell.id, sample.task_id, sample.sample_id, repetition);
        manifest = addExperimentAttempt(manifest, {
          plan_sha256: manifest.plan_sha256,
          attempt_id: attemptId,
          cell_id: cell.id,
          task_id: sample.task_id,
          sample_id: sample.sample_id,
          repetition,
          retry: { attempt: 1, retry_of: null },
          run_receipt_sha256: sha(`run:${attemptId}`),
          condition_contract_sha256: sha(`condition:${attemptId}`),
          protocol_receipt_sha256: cell.protocol_sha256,
          evaluator_receipt_sha256: evaluatorReceiptSha256(receipt),
          status: "completed",
          failure: null,
          valid: true,
          invalid_reason: null,
        } satisfies ExperimentAttemptOutcome);
      }
    }
  }
  return manifest;
}

function manifestWithOneExcludedCoordinate(excludedStatus: "failed" | "completed" = "failed"): ExperimentManifest {
  const planValue = plan({ samples: 1, repetitions: 1 });
  let manifest = createExperimentManifest(planValue);
  for (const cell of manifest.plan.cells) {
    const sample = manifest.plan.samples[0];
    const attemptId = `${cell.id}-${sample.sample_id}-r1`;
    const excluded = cell.condition === "hoh";
    const completedReceipt = successfulReceipt(manifest.plan, cell.id, sample.task_id, sample.sample_id, 1);
    manifest = addExperimentAttempt(manifest, {
      plan_sha256: manifest.plan_sha256,
      attempt_id: attemptId,
      cell_id: cell.id,
      task_id: sample.task_id,
      sample_id: sample.sample_id,
      repetition: 1,
      retry: { attempt: 1, retry_of: null },
      run_receipt_sha256: sha(`run:${attemptId}`),
      condition_contract_sha256: sha(`condition:${attemptId}`),
      protocol_receipt_sha256: cell.protocol_sha256,
      evaluator_receipt_sha256: excluded && excludedStatus === "failed" ? null : evaluatorReceiptSha256(completedReceipt),
      status: excluded ? excludedStatus : "completed",
      failure:
        excluded && excludedStatus === "failed"
          ? { code: "infrastructure_failure", message: "worker unavailable before evaluation" }
          : null,
      valid: !excluded,
      invalid_reason: excluded ? "infrastructure_failure" : null,
    });
  }
  return manifest;
}

function evaluatorReceipt(
  planValue: ExperimentPlan,
  result: JsonValue | null,
  failed = false,
  inputHashes: { task: string; sample: string } = {
    task: planValue.samples[0].evaluator_task_sha256,
    sample: planValue.samples[0].evaluator_sample_sha256,
  },
): EvaluatorReceipt {
  const stdout = `${JSON.stringify(result)}\n`;
  const stderr = `${PRIVATE_EVALUATOR_TEXT}\n`;
  return {
    schema_version: 1,
    evaluator: {
      ...planValue.evaluator,
      argv: [...planValue.evaluator.argv],
      observed_executable_sha256_before: planValue.evaluator.executable_sha256,
      observed_executable_sha256_after: planValue.evaluator.executable_sha256,
    },
    boundary: {
      threat_model: "trusted_cooperative_evaluator",
      process_separated: true,
      serialized_input_blinded: true,
      filesystem_isolated: false,
      network_isolated: false,
      descendant_termination: "same_posix_process_group",
    },
    input: {
      serialized_bytes: 10,
      serialized_sha256: sha("serialized input"),
      artifact_filename: "artifact.bin",
      artifact_bytes: 8,
      artifact_sha256: sha("artifact"),
      task_bytes: 4,
      task_sha256: inputHashes.task,
      sample_bytes: 6,
      sample_sha256: inputHashes.sample,
    },
    process: {
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      duration_ms: 1_000,
      exit_code: failed ? 1 : 0,
      signal: null,
    },
    stdout: { raw: stdout, bytes: Buffer.byteLength(stdout), sha256: sha(stdout), truncated: false },
    stderr: { raw: stderr, bytes: Buffer.byteLength(stderr), sha256: sha(stderr), truncated: false },
    result,
    failure: failed ? { code: "nonzero_exit", message: PRIVATE_EVALUATOR_TEXT } : null,
  };
}

function successfulReceipt(
  planValue: ExperimentPlan,
  cellId: string,
  taskId: string,
  sampleId: string,
  repetition: number,
): EvaluatorReceipt {
  const conditionIndex = planValue.cells.findIndex((cell) => cell.id === cellId);
  const sampleIndex = planValue.samples.findIndex((sample) => sample.task_id === taskId && sample.sample_id === sampleId);
  const sample = planValue.samples[sampleIndex];
  const value = conditionIndex * 100 + sampleIndex * 10 + repetition;
  return evaluatorReceipt(
    planValue,
    {
      task_success_rate: value,
      qa_pass: 1,
      coverage: 100,
      private_detail: PRIVATE_EVALUATOR_TEXT,
    },
    false,
    { task: sample.evaluator_task_sha256, sample: sample.evaluator_sample_sha256 },
  );
}

function manifestWithSingleCompletedAttempt(
  planValue: ExperimentPlan,
  receipt: EvaluatorReceipt,
  receiptSha256 = evaluatorReceiptSha256(receipt),
): ExperimentManifest {
  let manifest = createExperimentManifest(planValue);
  const cell = manifest.plan.cells[0];
  const sample = manifest.plan.samples[0];
  manifest = addExperimentAttempt(manifest, {
    plan_sha256: manifest.plan_sha256,
    attempt_id: "single-attempt",
    cell_id: cell.id,
    task_id: sample.task_id,
    sample_id: sample.sample_id,
    repetition: 1,
    retry: { attempt: 1, retry_of: null },
    run_receipt_sha256: sha("single run"),
    condition_contract_sha256: sha("single condition"),
    protocol_receipt_sha256: cell.protocol_sha256,
    evaluator_receipt_sha256: receiptSha256,
    status: "completed",
    failure: null,
    valid: true,
    invalid_reason: null,
  });
  return manifest;
}

function dataset(manifest = completedManifest()): {
  manifest: ExperimentManifest;
  records: RawExperimentResult[];
  sources: EvaluatorReceiptSource[];
} {
  const records: RawExperimentResult[] = [];
  const sources: EvaluatorReceiptSource[] = [];
  for (const attempt of manifest.attempts) {
    if (attempt.evaluator_receipt_sha256 === null) continue;
    const receipt =
      attempt.status === "completed"
        ? successfulReceipt(manifest.plan, attempt.cell_id, attempt.task_id, attempt.sample_id, attempt.repetition)
        : evaluatorReceipt(manifest.plan, null, true);
    const receiptPath = `receipts/${attempt.attempt_id}.json`;
    sources.push({ path: receiptPath, receipt });
    records.push(
      createRawExperimentResult({
        manifest,
        attemptId: attempt.attempt_id,
        evaluatorReceipt: receipt,
        evaluatorReceiptPath: receiptPath,
      }),
    );
  }
  return { manifest, records, sources };
}

test("raw results extract only the exact pre-registered finite numeric evaluator metric", () => {
  const planValue = plan({ samples: 1, repetitions: 1 });
  const receipt = evaluatorReceipt(planValue, {
    task_success_rate: 0.75,
    qa_pass: true,
    coverage: 99,
    ledger: PRIVATE_EVALUATOR_TEXT,
  });
  const manifest = manifestWithSingleCompletedAttempt(planValue, receipt);
  const attempt = manifest.attempts[0];
  const record = createRawExperimentResult({
    manifest,
    attemptId: attempt.attempt_id,
    evaluatorReceipt: receipt,
    evaluatorReceiptPath: "receipts/attempt.json",
  });

  assert.deepEqual(record.metric, { name: "task_success_rate", value: 0.75 });
  assert.equal(record.evaluator_receipt_sha256, evaluatorReceiptSha256(receipt));
  assert.equal(evaluatorReceiptSha256(receipt), canonicalSha256(receipt));
  assert.deepEqual(Object.keys(record).sort(), [
    "attempt_id",
    "cell_id",
    "condition",
    "evaluator_receipt_path",
    "evaluator_receipt_sha256",
    "exclusion_rule",
    "metric",
    "plan_sha256",
    "repetition",
    "retry",
    "run_receipt_sha256",
    "sample_id",
    "schema_version",
    "status",
    "task_id",
    "valid",
  ]);
  assert.doesNotMatch(JSON.stringify(record), /qa_pass|coverage|ledger|stdout|stderr|PRIVATE_EVALUATOR/);

  const manifestHashMismatch = manifestWithSingleCompletedAttempt(planValue, receipt, sha("different evaluator receipt"));
  assert.throws(
    () =>
      createRawExperimentResult({
        manifest: manifestHashMismatch,
        attemptId: manifestHashMismatch.attempts[0].attempt_id,
        evaluatorReceipt: receipt,
        evaluatorReceiptPath: "receipts/hash-mismatch.json",
      }),
    /canonical evaluator receipt SHA-256 does not match the manifest attempt/,
  );

  const wrongInputReceipt = evaluatorReceipt(
    planValue,
    { task_success_rate: 0.75 },
    false,
    { task: sha("wrong evaluator task"), sample: planValue.samples[0].evaluator_sample_sha256 },
  );
  const wrongInputManifest = manifestWithSingleCompletedAttempt(planValue, wrongInputReceipt);
  assert.throws(
    () =>
      createRawExperimentResult({
        manifest: wrongInputManifest,
        attemptId: wrongInputManifest.attempts[0].attempt_id,
        evaluatorReceipt: wrongInputReceipt,
        evaluatorReceiptPath: "receipts/wrong-input.json",
      }),
    /task\/sample hashes do not match the pre-registered sample inputs/,
  );

  for (const [label, result, error] of [
    ["missing", { Task_success_rate: 0.75 }, /missing exact metric field/],
    ["non-number", { task_success_rate: "0.75" }, /must be a number/],
    ["non-finite", { task_success_rate: Number.POSITIVE_INFINITY }, /non-finite|must be finite/],
  ] as const) {
    const invalidReceipt = evaluatorReceipt(planValue, result as JsonValue);
    const invalidManifest = manifestWithSingleCompletedAttempt(
      planValue,
      invalidReceipt,
      label === "non-finite" ? sha("non-finite receipt placeholder") : evaluatorReceiptSha256(invalidReceipt),
    );
    assert.throws(
      () =>
        createRawExperimentResult({
          manifest: invalidManifest,
          attemptId: invalidManifest.attempts[0].attempt_id,
          evaluatorReceipt: invalidReceipt,
          evaluatorReceiptPath: `receipts/${label}.json`,
        }),
      error,
      label,
    );
  }
});

test("raw result parsing rejects receipt hashes, manifest coordinates, metric values, and duplicate attempts", () => {
  const data = dataset(completedManifest(plan({ samples: 1, repetitions: 1 })));
  const original = data.records[0];
  const source = data.sources[0];
  const binding = {
    manifest: data.manifest,
    evaluatorReceipt: source.receipt,
    evaluatorReceiptPath: source.path,
  };

  assert.throws(
    () => parseRawExperimentResult({ ...original, evaluator_receipt_sha256: "f".repeat(64) }, binding),
    /evaluator_receipt_sha256 does not match/,
  );
  assert.throws(
    () => parseRawExperimentResult({ ...original, cell_id: "cell-vanilla" }, binding),
    /cell_id does not match the manifest attempt/,
  );
  assert.throws(
    () => parseRawExperimentResult({ ...original, run_receipt_sha256: sha("wrong run") }, binding),
    /run_receipt_sha256 does not match the manifest attempt/,
  );
  assert.throws(
    () => parseRawExperimentResult({ ...original, metric: { ...original.metric, value: 12345 } }, binding),
    /metric.value does not match/,
  );
  assert.throws(
    () => serializeRawExperimentResultsJsonl([original, original], data.manifest, data.sources),
    /duplicate attempt_id/,
  );
  assert.throws(
    () => parseRawExperimentResult({ ...original, unregistered_field: "not allowed" }, binding),
    /unknown field/,
  );
  for (const invalidPath of ["/absolute.json", "../escape.json", "receipts/../escape.json", "receipts\\escape.json", "./receipt.json", "C:/receipt.json", "receipts/\u0001.json"]) {
    assert.throws(
      () =>
        createRawExperimentResult({
          manifest: data.manifest,
          attemptId: original.attempt_id,
          evaluatorReceipt: source.receipt,
          evaluatorReceiptPath: invalidPath,
        }),
      /must be a canonical POSIX relative path/,
      invalidPath,
    );
  }

  const changedReceipt = structuredClone(source.receipt) as unknown as { process: { duration_ms: number } };
  changedReceipt.process.duration_ms += 1;
  assert.throws(
    () => parseRawExperimentResult(original, { ...binding, evaluatorReceipt: changedReceipt as unknown as EvaluatorReceipt }),
    /evaluator_receipt_sha256 does not match/,
  );

  const abbreviatedReceipt = {
    schema_version: 1,
    evaluator: source.receipt.evaluator,
    process: source.receipt.process,
    result: source.receipt.result,
    failure: null,
  };
  assert.throws(
    () =>
      createRawExperimentResult({
        manifest: data.manifest,
        attemptId: original.attempt_id,
        evaluatorReceipt: abbreviatedReceipt as unknown as EvaluatorReceipt,
        evaluatorReceiptPath: "receipts/abbreviated.json",
      }),
    /evaluator receipt is missing boundary, input, stdout, stderr/,
  );

  const badStreamHash = structuredClone(source.receipt) as unknown as { stdout: { sha256: string } };
  badStreamHash.stdout.sha256 = sha("not stdout");
  assert.throws(() => evaluatorReceiptSha256(badStreamHash), /stdout.sha256 does not match its raw bytes/);
  const badStreamBytes = structuredClone(source.receipt) as unknown as { stderr: { bytes: number } };
  badStreamBytes.stderr.bytes += 1;
  assert.throws(() => evaluatorReceiptSha256(badStreamBytes), /stderr.bytes does not match its UTF-8 raw bytes/);

  const mismatchedResult = structuredClone(source.receipt) as unknown as { result: { task_success_rate: number } };
  mismatchedResult.result.task_success_rate += 1;
  assert.throws(() => evaluatorReceiptSha256(mismatchedResult), /result does not match its stdout JSON value/);
});

test("canonical JSONL is strict, deterministic, and round-trips with receipt verification", () => {
  const data = dataset(completedManifest(plan({ samples: 2, repetitions: 1 })));
  const reversed = [...data.records].reverse();
  const serialized = serializeRawExperimentResultsJsonl(reversed, data.manifest, data.sources);
  const lines = serialized.trimEnd().split("\n");

  assert.ok(serialized.endsWith("\n"));
  assert.deepEqual(lines, [...lines].sort(), "records are deterministically ordered by attempt id");
  for (const line of lines) assert.equal(line, canonicalJson(JSON.parse(line)));
  assert.deepEqual(parseRawExperimentResultsJsonl(serialized, data.manifest, data.sources), [...data.records].sort(byAttemptId));
  assert.throws(
    () => parseRawExperimentResultsJsonl(`${JSON.stringify(data.records[0])}\n`, data.manifest, data.sources),
    /not canonical JSON/,
  );
  assert.throws(
    () => parseRawExperimentResultsJsonl(serialized.slice(0, -1), data.manifest, data.sources),
    /must end with a newline/,
  );
  assert.equal(
    parseRawExperimentResultsJsonl(`${[...lines].reverse().join("\n")}\n`, data.manifest, data.sources).length,
    data.records.length,
    "append order does not change per-line canonical validity",
  );
});

test("only exact pre-registered exclusions can explain invalid or missing results", () => {
  const planValue = plan({ samples: 1, repetitions: 1 });
  const failedReceipt = evaluatorReceipt(planValue, null, true);
  let invalidManifest = createExperimentManifest(planValue);
  invalidManifest = addExperimentAttempt(invalidManifest, {
    plan_sha256: invalidManifest.plan_sha256,
    attempt_id: "excluded-attempt",
    cell_id: "cell-hoh",
    task_id: "benchmark-task",
    sample_id: "sample-1",
    repetition: 1,
    retry: { attempt: 1, retry_of: null },
    run_receipt_sha256: sha("excluded run"),
    condition_contract_sha256: sha("excluded condition"),
    protocol_receipt_sha256: planValue.cells[0].protocol_sha256,
    evaluator_receipt_sha256: evaluatorReceiptSha256(failedReceipt),
    status: "failed",
    failure: { code: "nonzero_exit", message: "external evaluator exited unsuccessfully" },
    valid: false,
    invalid_reason: "nonzero_exit",
  });
  const excluded = createRawExperimentResult({
    manifest: invalidManifest,
    attemptId: "excluded-attempt",
    evaluatorReceipt: failedReceipt,
    evaluatorReceiptPath: "receipts/excluded.json",
  });
  assert.equal(excluded.metric.value, null);
  assert.equal(excluded.exclusion_rule, "nonzero_exit");

  let mismatchedFailure = createExperimentManifest(planValue);
  mismatchedFailure = addExperimentAttempt(mismatchedFailure, {
    ...invalidManifest.attempts[0],
    plan_sha256: mismatchedFailure.plan_sha256,
    attempt_id: "mismatched-evaluator-failure",
    failure: { code: "infrastructure_failure", message: "different failure layer" },
    invalid_reason: "infrastructure_failure",
  });
  assert.throws(
    () =>
      createRawExperimentResult({
        manifest: mismatchedFailure,
        attemptId: "mismatched-evaluator-failure",
        evaluatorReceipt: failedReceipt,
        evaluatorReceiptPath: "receipts/mismatched-evaluator-failure.json",
      }),
    /evaluator failure code does not match attempt failure and exclusion/,
  );

  const successfulReceiptForFailure = evaluatorReceipt(planValue, { task_success_rate: 0.1 });
  let failedWithSuccess = createExperimentManifest(planValue);
  failedWithSuccess = addExperimentAttempt(failedWithSuccess, {
    ...invalidManifest.attempts[0],
    plan_sha256: failedWithSuccess.plan_sha256,
    attempt_id: "failed-with-successful-evaluator",
    evaluator_receipt_sha256: evaluatorReceiptSha256(successfulReceiptForFailure),
  });
  assert.throws(
    () =>
      createRawExperimentResult({
        manifest: failedWithSuccess,
        attemptId: "failed-with-successful-evaluator",
        evaluatorReceipt: successfulReceiptForFailure,
        evaluatorReceiptPath: "receipts/failed-with-successful-evaluator.json",
      }),
    /failed attempt "failed-with-successful-evaluator" cannot use a successful evaluator receipt/,
  );

  let completedWithFailure = createExperimentManifest(planValue);
  completedWithFailure = addExperimentAttempt(completedWithFailure, {
    ...invalidManifest.attempts[0],
    plan_sha256: completedWithFailure.plan_sha256,
    attempt_id: "completed-with-failed-evaluator",
    evaluator_receipt_sha256: evaluatorReceiptSha256(failedReceipt),
    status: "completed",
    failure: null,
  });
  assert.throws(
    () =>
      createRawExperimentResult({
        manifest: completedWithFailure,
        attemptId: "completed-with-failed-evaluator",
        evaluatorReceipt: failedReceipt,
        evaluatorReceiptPath: "receipts/completed-with-failed-evaluator.json",
      }),
    /completed attempt "completed-with-failed-evaluator" cannot use a failed evaluator receipt/,
  );

  assert.throws(
    () =>
      addExperimentAttempt(createExperimentManifest(planValue), {
        ...invalidManifest.attempts[0],
        plan_sha256: createExperimentManifest(planValue).plan_sha256,
        attempt_id: "post-hoc-exclusion",
        invalid_reason: "looks_like_an_outlier",
      }),
    /must exactly match a pre-registered exclusion rule/,
  );

  const complete = dataset(completedManifest(plan({ samples: 1, repetitions: 1 })));
  assert.throws(
    () => aggregateExperimentResults(complete.manifest, complete.records.slice(1), complete.sources),
    /arbitrarily omit manifest attempt/,
  );

  const noAttempts = createExperimentManifest(plan({ samples: 1, repetitions: 1 }));
  assert.throws(
    () => aggregateExperimentResults(noAttempts, [], []),
    /planned coordinate is missing without a pre-registered exclusion/,
  );

  const fullWithExclusion = dataset(manifestWithOneExcludedCoordinate());
  const summary = aggregateExperimentResults(
    fullWithExclusion.manifest,
    fullWithExclusion.records,
    fullWithExclusion.sources,
  );
  assert.deepEqual(summary.excluded_attempt_ids, ["cell-hoh-sample-1-r1"]);
  assert.equal(summary.conditions[0].count, 0);
  assert.equal(summary.conditions[0].mean, null);
  assert.equal(summary.conditions[0].bootstrap_95_ci, null);

  const withoutExcludedRaw = aggregateExperimentResults(
    fullWithExclusion.manifest,
    fullWithExclusion.records.filter((record) => record.attempt_id !== "cell-hoh-sample-1-r1"),
    fullWithExclusion.sources.filter((source) => source.path !== "receipts/cell-hoh-sample-1-r1.json"),
  );
  assert.deepEqual(withoutExcludedRaw, summary, "a pre-registered exclusion may precede evaluator execution");

  const completedExclusion = dataset(manifestWithOneExcludedCoordinate("completed"));
  assert.throws(
    () =>
      aggregateExperimentResults(
        completedExclusion.manifest,
        completedExclusion.records.filter((record) => record.attempt_id !== "cell-hoh-sample-1-r1"),
        completedExclusion.sources,
      ),
    /arbitrarily omit manifest attempt/,
    "a completed exclusion still requires its external evaluator raw record",
  );
});

test("all five conditions use sample-macro means and seed-derived bootstrap independent of input order", () => {
  const data = dataset();
  const first = aggregateExperimentResults(data.manifest, data.records, data.sources);
  const shuffled = aggregateExperimentResults(data.manifest, deterministicShuffle(data.records), [...data.sources].reverse());

  assert.deepEqual(shuffled, first);
  assert.deepEqual(
    first.conditions.map((condition) => condition.condition),
    EXPERIMENT_CONDITIONS,
  );
  for (let index = 0; index < first.conditions.length; index += 1) {
    const condition = first.conditions[index];
    assert.equal(condition.count, 6);
    assert.equal(condition.mean, index * 100 + 11.5);
    assert.ok(condition.bootstrap_95_ci);
    assert.ok(condition.bootstrap_95_ci.lower <= condition.mean);
    assert.ok(condition.bootstrap_95_ci.upper >= condition.mean);
  }
  assert.deepEqual(first.included_attempt_ids, [...first.included_attempt_ids].sort());
  assert.deepEqual(first.excluded_attempt_ids, []);
  assert.equal(first.assignment_seed, 42);
  assert.equal(first.bootstrap_iterations, 10_000);
  assert.deepEqual(aggregateExperimentResults(data.manifest, data.records, data.sources), first, "same seed is reproducible");
});

test("a condition with fewer than two independent samples has an explicit null CI, never NaN or Infinity", () => {
  const data = dataset(completedManifest(plan({ samples: 1, repetitions: 1 })));
  const summary = aggregateExperimentResults(data.manifest, data.records, data.sources);
  for (const condition of summary.conditions) {
    assert.equal(condition.count, 1);
    assert.equal(typeof condition.mean, "number");
    assert.equal(condition.bootstrap_95_ci, null);
  }
  const serialized = serializeExperimentAggregateSummary(summary);
  assert.ok(serialized.endsWith("\n"));
  assert.equal(serialized.trimEnd(), canonicalJson(summary));
  assert.doesNotMatch(serialized, /NaN|Infinity|stdout|stderr|qa_pass|coverage|ledger|PRIVATE_EVALUATOR/);
});

test("aggregation API exposes no development-QA score fallback surface", () => {
  assert.deepEqual(
    Object.keys(aggregateApi).filter((name) => /qa|check|coverage|ledger/i.test(name)),
    [],
  );
  const data = dataset(completedManifest(plan({ samples: 1, repetitions: 1 })));
  const summary = aggregateExperimentResults(data.manifest, data.records, data.sources);
  assert.deepEqual(Object.keys(summary).sort(), [
    "aggregation",
    "assignment_seed",
    "bootstrap_iterations",
    "conditions",
    "excluded_attempt_ids",
    "included_attempt_ids",
    "metric",
    "plan_sha256",
    "schema_version",
    "uncertainty",
  ]);

  assert.throws(
    () => completedManifest({ ...plan({ samples: 1, repetitions: 1 }), aggregation: "median" } as unknown as ExperimentPlan),
    /aggregation must be exactly "macro_mean"/,
  );
  assert.throws(
    () => completedManifest({ ...plan({ samples: 1, repetitions: 1 }), uncertainty: "normal_95_ci" } as unknown as ExperimentPlan),
    /uncertainty must be exactly "bootstrap_95_ci"/,
  );
});

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byAttemptId(left: RawExperimentResult, right: RawExperimentResult): number {
  return left.attempt_id < right.attempt_id ? -1 : left.attempt_id > right.attempt_id ? 1 : 0;
}

function deterministicShuffle<T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let index = 0; index < result.length; index += 2) {
    const target = (index * 7 + 3) % result.length;
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}
