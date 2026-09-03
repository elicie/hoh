/** Canonical external-evaluator result records and deterministic experiment aggregation. */
import { createHash } from "node:crypto";
import { EVALUATOR_LIMITS, type EvaluatorReceipt, type JsonValue } from "./evaluator.js";
import {
  EXPERIMENT_CONDITIONS,
  parseExperimentManifest,
  type ExperimentAttemptOutcome,
  type ExperimentCondition,
  type ExperimentManifest,
} from "./manifest.js";
import { canonicalJson, canonicalSha256 } from "../runtime/protocol.js";

export const EXPERIMENT_BOOTSTRAP_ITERATIONS = 10_000;

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const ATTEMPT_STATUSES = new Set(["completed", "failed", "cancelled"]);
const EVALUATOR_FAILURE_CODES = new Set([
  "cancelled",
  "timed_out",
  "output_too_large",
  "spawn_error",
  "nonzero_exit",
  "invalid_json",
  "evaluator_identity_mismatch",
]);

export interface RawExperimentResult {
  readonly schema_version: 1;
  readonly plan_sha256: string;
  readonly attempt_id: string;
  readonly cell_id: string;
  readonly task_id: string;
  readonly sample_id: string;
  readonly repetition: number;
  readonly retry: {
    readonly attempt: number;
    readonly retry_of: string | null;
  };
  readonly condition: ExperimentCondition;
  readonly status: ExperimentAttemptOutcome["status"];
  readonly metric: {
    readonly name: string;
    /** Null only when the external evaluator itself has a recorded failure. */
    readonly value: number | null;
  };
  readonly run_receipt_sha256: string;
  /** Canonical SHA-256 of the complete, separately retained evaluator receipt. */
  readonly evaluator_receipt_sha256: string;
  readonly evaluator_receipt_path: string;
  readonly valid: boolean;
  /** Exact member of plan.exclusion_rules for invalid attempts; otherwise null. */
  readonly exclusion_rule: string | null;
}

export interface EvaluatorReceiptSource {
  readonly path: string;
  readonly receipt: EvaluatorReceipt;
}

export interface ExperimentConditionAggregate {
  readonly condition: ExperimentCondition;
  /** Number of valid completed attempt results included in the macro mean. */
  readonly count: number;
  readonly mean: number | null;
  /** Null when fewer than two samples have an included result. */
  readonly bootstrap_95_ci: {
    readonly lower: number;
    readonly upper: number;
  } | null;
}

export interface ExperimentAggregateSummary {
  readonly schema_version: 1;
  readonly plan_sha256: string;
  readonly metric: string;
  readonly aggregation: "macro_mean";
  readonly uncertainty: "bootstrap_95_ci";
  readonly assignment_seed: number;
  readonly bootstrap_iterations: typeof EXPERIMENT_BOOTSTRAP_ITERATIONS;
  readonly conditions: readonly ExperimentConditionAggregate[];
  readonly included_attempt_ids: readonly string[];
  readonly excluded_attempt_ids: readonly string[];
}

export interface RawExperimentResultBinding {
  readonly manifest: ExperimentManifest;
  readonly evaluatorReceipt: EvaluatorReceipt;
  readonly evaluatorReceiptPath: string;
}

/** Canonical SHA-256 of every field in the complete evaluator receipt. */
export function evaluatorReceiptSha256(receipt: unknown): string {
  assertEvaluatorReceiptV1(receipt);
  return canonicalSha256(receipt);
}

/**
 * Bind one immutable manifest attempt to one external evaluator receipt.
 * Only the pre-registered metric is copied out of the receipt result.
 */
export function createRawExperimentResult(options: {
  readonly manifest: unknown;
  readonly attemptId: string;
  readonly evaluatorReceipt: EvaluatorReceipt;
  readonly evaluatorReceiptPath: string;
}): RawExperimentResult {
  const manifest = parseExperimentManifest(options.manifest);
  const attempt = manifest.attempts.find((candidate) => candidate.attempt_id === options.attemptId);
  if (!attempt) fail(`attempt_id does not name a manifest attempt: ${JSON.stringify(options.attemptId)}`);
  const cell = manifest.plan.cells.find((candidate) => candidate.id === attempt.cell_id);
  if (!cell) fail(`manifest attempt ${JSON.stringify(attempt.attempt_id)} references an unknown cell`);
  const receiptSha256 = evaluatorReceiptSha256(options.evaluatorReceipt);
  if (attempt.evaluator_receipt_sha256 === null) {
    fail(`manifest attempt ${JSON.stringify(attempt.attempt_id)} is pre-evaluation and cannot have a raw evaluator result`);
  }
  if (receiptSha256 !== attempt.evaluator_receipt_sha256) {
    fail("canonical evaluator receipt SHA-256 does not match the manifest attempt");
  }
  const metricValue = extractMetric(manifest, attempt, options.evaluatorReceipt);
  const candidate: RawExperimentResult = {
    schema_version: 1,
    plan_sha256: manifest.plan_sha256,
    attempt_id: attempt.attempt_id,
    cell_id: attempt.cell_id,
    task_id: attempt.task_id,
    sample_id: attempt.sample_id,
    repetition: attempt.repetition,
    retry: { ...attempt.retry },
    condition: cell.condition,
    status: attempt.status,
    metric: { name: manifest.plan.metric, value: metricValue },
    run_receipt_sha256: attempt.run_receipt_sha256,
    evaluator_receipt_sha256: receiptSha256,
    evaluator_receipt_path: options.evaluatorReceiptPath,
    valid: attempt.valid,
    exclusion_rule: attempt.invalid_reason,
  };
  return parseRawExperimentResult(candidate, {
    manifest,
    evaluatorReceipt: options.evaluatorReceipt,
    evaluatorReceiptPath: options.evaluatorReceiptPath,
  });
}

/** Strictly parse and independently verify one raw result and its receipt binding. */
export function parseRawExperimentResult(value: unknown, binding: RawExperimentResultBinding): RawExperimentResult {
  const manifest = parseExperimentManifest(binding.manifest);
  const raw = record(value, "raw result");
  exactKeys(
    raw,
    [
      "schema_version",
      "plan_sha256",
      "attempt_id",
      "cell_id",
      "task_id",
      "sample_id",
      "repetition",
      "retry",
      "condition",
      "status",
      "metric",
      "run_receipt_sha256",
      "evaluator_receipt_sha256",
      "evaluator_receipt_path",
      "valid",
      "exclusion_rule",
    ],
    "raw result",
  );
  if (raw.schema_version !== 1) fail("schema_version must be 1");

  const planSha256 = sha256(raw.plan_sha256, "plan_sha256");
  if (planSha256 !== manifest.plan_sha256) fail("plan_sha256 does not match the manifest");
  const attemptId = identifier(raw.attempt_id, "attempt_id");
  const attempt = manifest.attempts.find((candidate) => candidate.attempt_id === attemptId);
  if (!attempt) fail(`attempt_id does not name a manifest attempt: ${JSON.stringify(attemptId)}`);
  const cell = manifest.plan.cells.find((candidate) => candidate.id === attempt.cell_id);
  if (!cell) fail(`manifest attempt ${JSON.stringify(attemptId)} references an unknown cell`);

  const cellId = identifier(raw.cell_id, "cell_id");
  const taskId = identifier(raw.task_id, "task_id");
  const sampleId = identifier(raw.sample_id, "sample_id");
  const repetition = positiveSafeInteger(raw.repetition, "repetition");
  const retryRaw = record(raw.retry, "retry");
  exactKeys(retryRaw, ["attempt", "retry_of"], "retry");
  const retryAttempt = positiveSafeInteger(retryRaw.attempt, "retry.attempt");
  const retryOf = retryRaw.retry_of === null ? null : identifier(retryRaw.retry_of, "retry.retry_of");
  const condition = identifier(raw.condition, "condition");
  const status = identifier(raw.status, "status");
  if (!ATTEMPT_STATUSES.has(status)) fail("status must be completed, failed, or cancelled");
  const runReceiptSha256 = sha256(raw.run_receipt_sha256, "run_receipt_sha256");
  if (typeof raw.valid !== "boolean") fail("valid must be a boolean");
  const valid = raw.valid;
  const exclusionRule = raw.exclusion_rule === null ? null : identifier(raw.exclusion_rule, "exclusion_rule");

  match(cellId, attempt.cell_id, "cell_id");
  match(taskId, attempt.task_id, "task_id");
  match(sampleId, attempt.sample_id, "sample_id");
  match(repetition, attempt.repetition, "repetition");
  match(retryAttempt, attempt.retry.attempt, "retry.attempt");
  match(retryOf, attempt.retry.retry_of, "retry.retry_of");
  match(condition, cell.condition, "condition");
  match(status, attempt.status, "status");
  match(runReceiptSha256, attempt.run_receipt_sha256, "run_receipt_sha256");
  match(valid, attempt.valid, "valid");
  match(exclusionRule, attempt.invalid_reason, "exclusion_rule");
  validateExclusion(manifest, valid, exclusionRule);

  const evaluatorReceiptPath = receiptPath(raw.evaluator_receipt_path, "evaluator_receipt_path");
  const expectedPath = receiptPath(binding.evaluatorReceiptPath, "receipt source path");
  match(evaluatorReceiptPath, expectedPath, "evaluator_receipt_path");
  const recordedEvaluatorReceiptSha256 = sha256(raw.evaluator_receipt_sha256, "evaluator_receipt_sha256");
  const actualEvaluatorReceiptSha256 = evaluatorReceiptSha256(binding.evaluatorReceipt);
  if (recordedEvaluatorReceiptSha256 !== actualEvaluatorReceiptSha256) {
    fail(
      `evaluator_receipt_sha256 does not match the canonical evaluator receipt (${recordedEvaluatorReceiptSha256} != ${actualEvaluatorReceiptSha256})`,
    );
  }
  if (attempt.evaluator_receipt_sha256 === null || recordedEvaluatorReceiptSha256 !== attempt.evaluator_receipt_sha256) {
    fail("evaluator_receipt_sha256 does not match the manifest attempt");
  }

  const metricRaw = record(raw.metric, "metric");
  exactKeys(metricRaw, ["name", "value"], "metric");
  const metricName = identifier(metricRaw.name, "metric.name");
  match(metricName, manifest.plan.metric, "metric.name");
  const expectedMetricValue = extractMetric(manifest, attempt, binding.evaluatorReceipt);
  const metricValue = nullableFiniteNumber(metricRaw.value, "metric.value");
  if (!Object.is(metricValue, expectedMetricValue)) fail("metric.value does not match the external evaluator receipt");

  return deepFreeze({
    schema_version: 1,
    plan_sha256: planSha256,
    attempt_id: attemptId,
    cell_id: cellId,
    task_id: taskId,
    sample_id: sampleId,
    repetition,
    retry: { attempt: retryAttempt, retry_of: retryOf },
    condition: condition as ExperimentCondition,
    status: status as ExperimentAttemptOutcome["status"],
    metric: { name: metricName, value: metricValue },
    run_receipt_sha256: runReceiptSha256,
    evaluator_receipt_sha256: recordedEvaluatorReceiptSha256,
    evaluator_receipt_path: evaluatorReceiptPath,
    valid,
    exclusion_rule: exclusionRule,
  });
}

/** Parse canonical JSONL and verify every line against its manifest attempt and evaluator receipt. */
export function parseRawExperimentResultsJsonl(
  text: string,
  manifestValue: unknown,
  receiptSources: readonly EvaluatorReceiptSource[],
): readonly RawExperimentResult[] {
  if (typeof text !== "string") fail("JSONL input must be a string");
  const manifest = parseExperimentManifest(manifestValue);
  const sources = receiptSourceMap(receiptSources);
  if (text.length === 0) return Object.freeze([]);
  if (!text.endsWith("\n")) fail("canonical JSONL must end with a newline");
  const results: RawExperimentResult[] = [];
  const attemptIds = new Set<string>();
  const receiptPaths = new Set<string>();
  const lines = text.slice(0, -1).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length === 0) fail(`JSONL line ${index + 1} must not be blank`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new Error(`invalid experiment result: JSONL line ${index + 1} is not valid JSON`, { cause });
    }
    if (canonicalJson(value) !== line) fail(`JSONL line ${index + 1} is not canonical JSON`);
    const raw = record(value, `JSONL line ${index + 1}`);
    const sourcePath = receiptPath(raw.evaluator_receipt_path, `JSONL line ${index + 1}.evaluator_receipt_path`);
    const source = sources.get(sourcePath);
    if (!source) fail(`no evaluator receipt was supplied for ${JSON.stringify(sourcePath)}`);
    const result = parseRawExperimentResult(value, {
      manifest,
      evaluatorReceipt: source.receipt,
      evaluatorReceiptPath: source.path,
    });
    if (attemptIds.has(result.attempt_id)) fail(`duplicate attempt_id ${JSON.stringify(result.attempt_id)}`);
    if (receiptPaths.has(result.evaluator_receipt_path)) {
      fail(`duplicate evaluator_receipt_path ${JSON.stringify(result.evaluator_receipt_path)}`);
    }
    attemptIds.add(result.attempt_id);
    receiptPaths.add(result.evaluator_receipt_path);
    results.push(result);
  }
  return deepFreeze(results);
}

/** Validate, deterministically order, and serialize raw result records as canonical JSONL. */
export function serializeRawExperimentResultsJsonl(
  values: readonly unknown[],
  manifestValue: unknown,
  receiptSources: readonly EvaluatorReceiptSource[],
): string {
  const results = validateRawResults(values, manifestValue, receiptSources);
  return results.map((result) => canonicalJson(result)).join("\n") + (results.length > 0 ? "\n" : "");
}

/**
 * Aggregate only valid completed results. Every planned coordinate must be
 * represented by an included result or an exact pre-registered exclusion.
 * Excluded attempts may omit raw records when the evaluator never ran.
 */
export function aggregateExperimentResults(
  manifestValue: unknown,
  values: readonly unknown[],
  receiptSources: readonly EvaluatorReceiptSource[],
): ExperimentAggregateSummary {
  const manifest = parseExperimentManifest(manifestValue);
  if (manifest.plan.aggregation !== "macro_mean") fail('plan.aggregation must be exactly "macro_mean"');
  if (manifest.plan.uncertainty !== "bootstrap_95_ci") fail('plan.uncertainty must be exactly "bootstrap_95_ci"');
  const results = validateRawResults(values, manifest, receiptSources);
  validateAttemptAndCoordinateCoverage(manifest, results);

  const included = results.filter((result) => result.valid && result.status === "completed");
  const includedIds = new Set(included.map((result) => result.attempt_id));
  const excludedIds = manifest.attempts
    .filter((attempt) => !includedIds.has(attempt.attempt_id))
    .map((attempt) => attempt.attempt_id)
    .sort(compareText);
  const conditions = EXPERIMENT_CONDITIONS.map((condition) => {
    const conditionResults = included.filter((result) => result.condition === condition);
    const sampleMeans = manifest.plan.samples.flatMap((sample) => {
      const sampleResults = conditionResults
        .filter((result) => result.task_id === sample.task_id && result.sample_id === sample.sample_id)
        .sort(compareCoordinate);
      if (sampleResults.length === 0) return [];
      return [finiteMean(sampleResults.map((result) => requiredMetricValue(result)), `${condition} sample mean`)];
    });
    const mean = sampleMeans.length === 0 ? null : finiteMean(sampleMeans, `${condition} macro mean`);
    const bootstrap =
      sampleMeans.length < 2
        ? null
        : bootstrap95(sampleMeans, bootstrapSeed(manifest.plan.assignment_seed, manifest.plan_sha256, condition));
    return {
      condition,
      count: conditionResults.length,
      mean,
      bootstrap_95_ci: bootstrap,
    } satisfies ExperimentConditionAggregate;
  });

  return deepFreeze({
    schema_version: 1,
    plan_sha256: manifest.plan_sha256,
    metric: manifest.plan.metric,
    aggregation: "macro_mean",
    uncertainty: "bootstrap_95_ci",
    assignment_seed: manifest.plan.assignment_seed,
    bootstrap_iterations: EXPERIMENT_BOOTSTRAP_ITERATIONS,
    conditions,
    included_attempt_ids: included.map((result) => result.attempt_id).sort(compareText),
    excluded_attempt_ids: excludedIds,
  });
}

/** Canonical one-line representation suitable for preserving an aggregate summary. */
export function serializeExperimentAggregateSummary(summary: ExperimentAggregateSummary): string {
  return `${canonicalJson(summary)}\n`;
}

function validateRawResults(
  values: readonly unknown[],
  manifestValue: unknown,
  receiptSources: readonly EvaluatorReceiptSource[],
): readonly RawExperimentResult[] {
  if (!Array.isArray(values)) fail("raw results must be an array");
  const manifest = parseExperimentManifest(manifestValue);
  const sources = receiptSourceMap(receiptSources);
  const attemptIds = new Set<string>();
  const receiptPaths = new Set<string>();
  const results = values.map((value, index) => {
    const raw = record(value, `raw results[${index}]`);
    const sourcePath = receiptPath(raw.evaluator_receipt_path, `raw results[${index}].evaluator_receipt_path`);
    const source = sources.get(sourcePath);
    if (!source) fail(`no evaluator receipt was supplied for ${JSON.stringify(sourcePath)}`);
    const result = parseRawExperimentResult(value, {
      manifest,
      evaluatorReceipt: source.receipt,
      evaluatorReceiptPath: source.path,
    });
    if (attemptIds.has(result.attempt_id)) fail(`duplicate attempt_id ${JSON.stringify(result.attempt_id)}`);
    if (receiptPaths.has(result.evaluator_receipt_path)) {
      fail(`duplicate evaluator_receipt_path ${JSON.stringify(result.evaluator_receipt_path)}`);
    }
    attemptIds.add(result.attempt_id);
    receiptPaths.add(result.evaluator_receipt_path);
    return result;
  });
  return deepFreeze([...results].sort((left, right) => compareText(left.attempt_id, right.attempt_id)));
}

function validateAttemptAndCoordinateCoverage(manifest: ExperimentManifest, results: readonly RawExperimentResult[]): void {
  const actualIds = new Set(results.map((result) => result.attempt_id));
  const missingAttempts = manifest.attempts.filter((attempt) => !actualIds.has(attempt.attempt_id));
  const arbitraryMissing = missingAttempts.filter((attempt) => !mayOmitEvaluatorResult(manifest, attempt));
  if (arbitraryMissing.length > 0) {
    fail(`raw results arbitrarily omit manifest attempt(s): ${arbitraryMissing.map((attempt) => attempt.attempt_id).join(", ")}`);
  }

  for (const cell of manifest.plan.cells) {
    for (const sample of manifest.plan.samples) {
      for (let repetition = 1; repetition <= manifest.plan.repetitions; repetition += 1) {
        const coordinateAttempts = manifest.attempts.filter(
          (attempt) =>
            attempt.cell_id === cell.id &&
            attempt.task_id === sample.task_id &&
            attempt.sample_id === sample.sample_id &&
            attempt.repetition === repetition,
        );
        if (coordinateAttempts.length === 0) {
          fail(`planned coordinate is missing without a pre-registered exclusion: ${cell.id}/${sample.task_id}/${sample.sample_id}/${repetition}`);
        }
        const included = results.filter(
          (result) =>
            result.cell_id === cell.id &&
            result.task_id === sample.task_id &&
            result.sample_id === sample.sample_id &&
            result.repetition === repetition &&
            result.valid &&
            result.status === "completed",
        );
        if (included.length > 1) {
          fail(`planned coordinate has more than one valid completed result: ${cell.id}/${sample.task_id}/${sample.sample_id}/${repetition}`);
        }
        if (included.length === 0 && !coordinateAttempts.some((attempt) => isPreRegisteredExclusion(manifest, attempt))) {
          fail(`planned coordinate is neither included nor covered by a pre-registered exclusion: ${cell.id}/${sample.task_id}/${sample.sample_id}/${repetition}`);
        }
      }
    }
  }
}

function receiptSourceMap(sources: readonly EvaluatorReceiptSource[]): ReadonlyMap<string, EvaluatorReceiptSource> {
  if (!Array.isArray(sources)) fail("evaluator receipt sources must be an array");
  const result = new Map<string, EvaluatorReceiptSource>();
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    if (!source || typeof source !== "object") fail(`evaluator receipt sources[${index}] must be an object`);
    const sourcePath = receiptPath(source.path, `evaluator receipt sources[${index}].path`);
    if (result.has(sourcePath)) fail(`duplicate evaluator receipt source path ${JSON.stringify(sourcePath)}`);
    if (!source.receipt || typeof source.receipt !== "object") {
      fail(`evaluator receipt sources[${index}].receipt must be an object`);
    }
    result.set(sourcePath, { path: sourcePath, receipt: source.receipt });
  }
  return result;
}

function assertEvaluatorReceiptV1(value: unknown): asserts value is EvaluatorReceipt {
  const receipt = record(value, "evaluator receipt");
  exactKeys(receipt, ["schema_version", "evaluator", "boundary", "input", "process", "stdout", "stderr", "result", "failure"], "evaluator receipt");
  if (receipt.schema_version !== 1) fail("evaluator receipt.schema_version must be 1");

  const evaluator = record(receipt.evaluator, "evaluator receipt.evaluator");
  exactKeys(
    evaluator,
    [
      "argv",
      "version",
      "rubric_sha256",
      "executable_sha256",
      "observed_executable_sha256_before",
      "observed_executable_sha256_after",
    ],
    "evaluator receipt.evaluator",
  );
  if (!Array.isArray(evaluator.argv) || evaluator.argv.length === 0 || evaluator.argv.length > EVALUATOR_LIMITS.argv_entries) {
    fail(`evaluator receipt.evaluator.argv must contain 1-${EVALUATOR_LIMITS.argv_entries} entries`);
  }
  let argvBytes = 0;
  for (let index = 0; index < evaluator.argv.length; index += 1) {
    argvBytes += Buffer.byteLength(nonEmptyText(evaluator.argv[index], `evaluator receipt.evaluator.argv[${index}]`));
  }
  if (argvBytes > EVALUATOR_LIMITS.argv_bytes) fail(`evaluator receipt.evaluator.argv exceeds ${EVALUATOR_LIMITS.argv_bytes} bytes`);
  nonEmptyText(evaluator.version, "evaluator receipt.evaluator.version");
  const executableSha256 = sha256(evaluator.executable_sha256, "evaluator receipt.evaluator.executable_sha256");
  sha256(evaluator.rubric_sha256, "evaluator receipt.evaluator.rubric_sha256");
  const observedBefore = sha256(
    evaluator.observed_executable_sha256_before,
    "evaluator receipt.evaluator.observed_executable_sha256_before",
  );
  const observedAfter =
    evaluator.observed_executable_sha256_after === null
      ? null
      : sha256(evaluator.observed_executable_sha256_after, "evaluator receipt.evaluator.observed_executable_sha256_after");
  if (observedBefore !== executableSha256) {
    fail("evaluator receipt does not confirm its registered executable identity before execution");
  }

  const boundary = record(receipt.boundary, "evaluator receipt.boundary");
  exactKeys(
    boundary,
    [
      "threat_model",
      "process_separated",
      "serialized_input_blinded",
      "filesystem_isolated",
      "network_isolated",
      "descendant_termination",
    ],
    "evaluator receipt.boundary",
  );
  if (
    boundary.threat_model !== "trusted_cooperative_evaluator" ||
    boundary.process_separated !== true ||
    boundary.serialized_input_blinded !== true ||
    boundary.filesystem_isolated !== false ||
    boundary.network_isolated !== false ||
    (boundary.descendant_termination !== "same_posix_process_group" && boundary.descendant_termination !== "immediate_child_only")
  ) {
    fail("evaluator receipt.boundary does not match the v1 trusted cooperative evaluator contract");
  }

  const input = record(receipt.input, "evaluator receipt.input");
  exactKeys(
    input,
    [
      "serialized_bytes",
      "serialized_sha256",
      "artifact_filename",
      "artifact_bytes",
      "artifact_sha256",
      "task_bytes",
      "task_sha256",
      "sample_bytes",
      "sample_sha256",
    ],
    "evaluator receipt.input",
  );
  boundedByteCount(input.serialized_bytes, EVALUATOR_LIMITS.serialized_input_bytes, "evaluator receipt.input.serialized_bytes");
  sha256(input.serialized_sha256, "evaluator receipt.input.serialized_sha256");
  if (input.artifact_filename !== "artifact.bin") fail('evaluator receipt.input.artifact_filename must be "artifact.bin"');
  boundedByteCount(input.artifact_bytes, EVALUATOR_LIMITS.artifact_bytes, "evaluator receipt.input.artifact_bytes");
  sha256(input.artifact_sha256, "evaluator receipt.input.artifact_sha256");
  boundedByteCount(input.task_bytes, EVALUATOR_LIMITS.task_bytes, "evaluator receipt.input.task_bytes");
  sha256(input.task_sha256, "evaluator receipt.input.task_sha256");
  boundedByteCount(input.sample_bytes, EVALUATOR_LIMITS.sample_bytes, "evaluator receipt.input.sample_bytes");
  sha256(input.sample_sha256, "evaluator receipt.input.sample_sha256");

  const processReceipt = record(receipt.process, "evaluator receipt.process");
  exactKeys(processReceipt, ["started_at", "finished_at", "duration_ms", "exit_code", "signal"], "evaluator receipt.process");
  const startedAt = isoTimestamp(processReceipt.started_at, "evaluator receipt.process.started_at");
  const finishedAt = isoTimestamp(processReceipt.finished_at, "evaluator receipt.process.finished_at");
  if (finishedAt < startedAt) fail("evaluator receipt.process.finished_at must not precede started_at");
  nonNegativeSafeInteger(processReceipt.duration_ms, "evaluator receipt.process.duration_ms");
  if (processReceipt.exit_code !== null) nonNegativeSafeInteger(processReceipt.exit_code, "evaluator receipt.process.exit_code");
  if (processReceipt.signal !== null) {
    const signal = nonEmptyText(processReceipt.signal, "evaluator receipt.process.signal");
    if (!/^SIG[A-Z0-9]+$/.test(signal)) fail("evaluator receipt.process.signal must be a Node signal name or null");
  }

  validateEvaluatorStream(receipt.stdout, "stdout", EVALUATOR_LIMITS.stdout_bytes);
  validateEvaluatorStream(receipt.stderr, "stderr", EVALUATOR_LIMITS.stderr_bytes);
  assertJsonValue(receipt.result, "evaluator receipt.result");

  let failureCode: string | null = null;
  if (receipt.failure !== null) {
    const failure = record(receipt.failure, "evaluator receipt.failure");
    exactKeys(failure, ["code", "message"], "evaluator receipt.failure");
    failureCode = nonEmptyText(failure.code, "evaluator receipt.failure.code");
    if (!EVALUATOR_FAILURE_CODES.has(failureCode)) fail("evaluator receipt.failure.code is not a v1 evaluator failure code");
    nonEmptyText(failure.message, "evaluator receipt.failure.message");
    if (receipt.result !== null) fail("failed evaluator receipt must have a null result");
  } else {
    if (processReceipt.exit_code !== 0 || processReceipt.signal !== null) {
      fail("successful evaluator receipt must record a zero exit code and no signal");
    }
    if (observedAfter !== executableSha256) {
      fail("successful evaluator receipt does not confirm its registered executable identity after execution");
    }
    if ((receipt.stdout as { truncated: unknown }).truncated || (receipt.stderr as { truncated: unknown }).truncated) {
      fail("successful evaluator receipt cannot contain a truncated stream");
    }
    let stdoutResult: unknown;
    try {
      const stdoutRaw = (receipt.stdout as { raw: string }).raw;
      if (stdoutRaw.trim().length === 0) fail("successful evaluator receipt stdout must contain one JSON value");
      stdoutResult = JSON.parse(stdoutRaw);
    } catch (cause) {
      throw new Error("invalid experiment result: successful evaluator receipt stdout must contain exactly one JSON value", { cause });
    }
    assertJsonValue(stdoutResult, "evaluator receipt.stdout JSON");
    if (canonicalJson(stdoutResult) !== canonicalJson(receipt.result)) {
      fail("successful evaluator receipt.result does not match its stdout JSON value");
    }
  }
  if (failureCode !== "evaluator_identity_mismatch" && observedAfter !== executableSha256) {
    fail("evaluator receipt executable identity changed without an evaluator_identity_mismatch failure");
  }
  if (failureCode === "evaluator_identity_mismatch" && observedAfter === executableSha256) {
    fail("evaluator_identity_mismatch receipt must record a changed or unreadable post-run executable");
  }
}

function validateEvaluatorStream(value: unknown, name: "stdout" | "stderr", limit: number): void {
  const stream = record(value, `evaluator receipt.${name}`);
  exactKeys(stream, ["raw", "bytes", "sha256", "truncated"], `evaluator receipt.${name}`);
  if (typeof stream.raw !== "string") fail(`evaluator receipt.${name}.raw must be a string`);
  const bytes = boundedByteCount(stream.bytes, limit, `evaluator receipt.${name}.bytes`);
  if (bytes !== Buffer.byteLength(stream.raw)) fail(`evaluator receipt.${name}.bytes does not match its UTF-8 raw bytes`);
  const storedSha256 = sha256(stream.sha256, `evaluator receipt.${name}.sha256`);
  const actualSha256 = createHash("sha256").update(stream.raw, "utf8").digest("hex");
  if (storedSha256 !== actualSha256) fail(`evaluator receipt.${name}.sha256 does not match its raw bytes`);
  if (typeof stream.truncated !== "boolean") fail(`evaluator receipt.${name}.truncated must be a boolean`);
}

function assertJsonValue(value: unknown, at: string): asserts value is JsonValue {
  const active = new WeakSet<object>();
  const pending: Array<{ value: unknown; at: string; exit: boolean }> = [{ value, at, exit: false }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) fail(`${current.at} contains a non-finite number`);
      continue;
    }
    if (!current.value || typeof current.value !== "object") fail(`${current.at} contains a non-JSON value`);
    if (current.exit) {
      active.delete(current.value);
      continue;
    }
    if (active.has(current.value)) fail(`${current.at} contains a cycle`);
    active.add(current.value);
    pending.push({ ...current, exit: true });
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], at: `${current.at}[${index}]`, exit: false });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) fail(`${current.at} contains a non-plain JSON object`);
    for (const [key, item] of Object.entries(current.value).reverse()) {
      pending.push({ value: item, at: `${current.at}.${key}`, exit: false });
    }
  }
}

function extractMetric(manifest: ExperimentManifest, attempt: ExperimentAttemptOutcome, receipt: EvaluatorReceipt): number | null {
  assertEvaluatorIdentity(manifest, attempt, receipt);
  if (attempt.status === "completed" && receipt.failure !== null) {
    fail(`completed attempt ${JSON.stringify(attempt.attempt_id)} cannot use a failed evaluator receipt`);
  }
  if (attempt.status !== "completed" && receipt.failure === null) {
    fail(`${attempt.status} attempt ${JSON.stringify(attempt.attempt_id)} cannot use a successful evaluator receipt`);
  }
  if (receipt.failure !== null) {
    if (attempt.valid) fail(`valid attempt ${JSON.stringify(attempt.attempt_id)} cannot use a failed evaluator receipt`);
    if (receipt.result !== null) fail("failed evaluator receipt must have a null result");
    if (attempt.failure?.code !== receipt.failure.code || attempt.invalid_reason !== receipt.failure.code) {
      fail(`evaluator failure code does not match attempt failure and exclusion: ${JSON.stringify(receipt.failure.code)}`);
    }
    return null;
  }
  const result = record(receipt.result, "evaluator receipt result");
  if (!Object.prototype.hasOwnProperty.call(result, manifest.plan.metric)) {
    fail(`evaluator receipt result is missing exact metric field ${JSON.stringify(manifest.plan.metric)}`);
  }
  const metric = result[manifest.plan.metric];
  if (typeof metric !== "number") fail(`evaluator metric ${JSON.stringify(manifest.plan.metric)} must be a number`);
  if (!Number.isFinite(metric)) fail(`evaluator metric ${JSON.stringify(manifest.plan.metric)} must be finite`);
  return Object.is(metric, -0) ? 0 : metric;
}

function assertEvaluatorIdentity(manifest: ExperimentManifest, attempt: ExperimentAttemptOutcome, receipt: EvaluatorReceipt): void {
  if (!receipt || typeof receipt !== "object") fail("evaluator receipt must be an object");
  if (
    receipt.schema_version !== 1 ||
    !Object.prototype.hasOwnProperty.call(receipt, "result") ||
    !Object.prototype.hasOwnProperty.call(receipt, "failure")
  ) {
    fail("evaluator receipt is malformed");
  }
  const evaluator = receipt.evaluator;
  if (!evaluator || typeof evaluator !== "object") fail("evaluator receipt identity is missing");
  if (
    canonicalJson(evaluator.argv) !== canonicalJson(manifest.plan.evaluator.argv) ||
    evaluator.version !== manifest.plan.evaluator.version ||
    evaluator.rubric_sha256 !== manifest.plan.evaluator.rubric_sha256 ||
    evaluator.executable_sha256 !== manifest.plan.evaluator.executable_sha256
  ) {
    fail("evaluator receipt identity does not match the pre-registered evaluator");
  }
  const sample = manifest.plan.samples.find(
    (candidate) => candidate.task_id === attempt.task_id && candidate.sample_id === attempt.sample_id,
  );
  if (!sample) fail(`manifest attempt ${JSON.stringify(attempt.attempt_id)} does not identify a planned sample`);
  if (
    receipt.input.task_sha256 !== sample.evaluator_task_sha256 ||
    receipt.input.sample_sha256 !== sample.evaluator_sample_sha256
  ) {
    fail("evaluator receipt task/sample hashes do not match the pre-registered sample inputs");
  }
  if (receipt.failure === null) {
    if (
      evaluator.observed_executable_sha256_before !== manifest.plan.evaluator.executable_sha256 ||
      evaluator.observed_executable_sha256_after !== manifest.plan.evaluator.executable_sha256
    ) {
      fail("successful evaluator receipt does not confirm the pre-registered executable identity");
    }
    if (receipt.process?.exit_code !== 0 || receipt.process.signal !== null) {
      fail("successful evaluator receipt must record a zero exit code and no signal");
    }
  }
}

function validateExclusion(manifest: ExperimentManifest, valid: boolean, exclusionRule: string | null): void {
  if (valid) {
    if (exclusionRule !== null) fail("valid result must not have an exclusion_rule");
    return;
  }
  if (exclusionRule === null) fail("invalid result must name an exclusion_rule");
  if (!manifest.plan.exclusion_rules.includes(exclusionRule)) {
    fail(`exclusion_rule is not pre-registered: ${JSON.stringify(exclusionRule)}`);
  }
}

function isPreRegisteredExclusion(manifest: ExperimentManifest, attempt: ExperimentAttemptOutcome): boolean {
  return !attempt.valid && attempt.invalid_reason !== null && manifest.plan.exclusion_rules.includes(attempt.invalid_reason);
}

function mayOmitEvaluatorResult(manifest: ExperimentManifest, attempt: ExperimentAttemptOutcome): boolean {
  return (
    attempt.evaluator_receipt_sha256 === null &&
    attempt.status !== "completed" &&
    attempt.failure !== null &&
    isPreRegisteredExclusion(manifest, attempt)
  );
}

function bootstrap95(values: readonly number[], seed: number): { lower: number; upper: number } {
  const random = mulberry32(seed);
  const estimates = new Array<number>(EXPERIMENT_BOOTSTRAP_ITERATIONS);
  for (let iteration = 0; iteration < EXPERIMENT_BOOTSTRAP_ITERATIONS; iteration += 1) {
    const sample = new Array<number>(values.length);
    for (let index = 0; index < values.length; index += 1) sample[index] = values[Math.floor(random() * values.length)];
    estimates[iteration] = finiteMean(sample, "bootstrap estimate");
  }
  estimates.sort((left, right) => left - right);
  return {
    lower: percentile(estimates, 0.025),
    upper: percentile(estimates, 0.975),
  };
}

function bootstrapSeed(assignmentSeed: number, planSha256: string, condition: ExperimentCondition): number {
  return createHash("sha256")
    .update(`hoh-bootstrap-95-ci\0${assignmentSeed}\0${planSha256}\0${condition}`, "utf8")
    .digest()
    .readUInt32BE(0);
}

function mulberry32(initial: number): () => number {
  let state = initial >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  if (!Number.isFinite(value)) fail("bootstrap percentile was not finite");
  return value;
}

function finiteMean(values: readonly number[], at: string): number {
  if (values.length === 0) fail(`${at} requires at least one value`);
  let result = 0;
  for (const value of values) result += value / values.length;
  if (!Number.isFinite(result)) fail(`${at} was not finite`);
  return result;
}

function requiredMetricValue(result: RawExperimentResult): number {
  if (result.metric.value === null) fail(`included attempt ${JSON.stringify(result.attempt_id)} has no metric value`);
  return result.metric.value;
}

function compareCoordinate(left: RawExperimentResult, right: RawExperimentResult): number {
  if (left.repetition !== right.repetition) return left.repetition - right.repetition;
  if (left.retry.attempt !== right.retry.attempt) return left.retry.attempt - right.retry.attempt;
  return compareText(left.attempt_id, right.attempt_id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${at} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], at: string): void {
  const allowed = new Set(keys);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0) fail(`${at} is missing ${missing.join(", ")}`);
  if (unknown.length > 0) fail(`${at} has unknown field(s): ${unknown.join(", ")}`);
}

function identifier(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || /[\0\r\n]/.test(value)) {
    fail(`${at} must be a non-empty string without surrounding whitespace, line breaks, or NUL bytes`);
  }
  return value;
}

function nonEmptyText(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${at} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function receiptPath(value: unknown, at: string): string {
  const result = identifier(value, at);
  const segments = result.split("/");
  if (
    result.startsWith("/") ||
    /^[A-Za-z]:/.test(result) ||
    result.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(result) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`${at} must be a canonical POSIX relative path without traversal, backslashes, or control characters`);
  }
  return result;
}

function positiveSafeInteger(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${at} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(`${at} must be a non-negative safe integer`);
  return value;
}

function boundedByteCount(value: unknown, limit: number, at: string): number {
  const result = nonNegativeSafeInteger(value, at);
  if (result > limit) fail(`${at} must not exceed ${limit}`);
  return result;
}

function isoTimestamp(value: unknown, at: string): string {
  const result = nonEmptyText(value, at);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== result) fail(`${at} must be a canonical ISO-8601 timestamp`);
  return result;
}

function nullableFiniteNumber(value: unknown, at: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${at} must be a finite number or null`);
  return value;
}

function sha256(value: unknown, at: string): string {
  if (typeof value !== "string" || !HEX_SHA256.test(value)) fail(`${at} must be a lowercase 64-character SHA-256 hex digest`);
  return value;
}

function match(actual: unknown, expected: unknown, field: string): void {
  if (!Object.is(actual, expected)) fail(`${field} does not match the manifest attempt`);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

function fail(message: string): never {
  throw new Error(`invalid experiment result: ${message}`);
}
