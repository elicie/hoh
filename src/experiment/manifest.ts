/** Pre-registered experiment plan and append-only attempt outcomes. */
import path from "node:path";
import { canonicalSha256 } from "../runtime/protocol.js";

export const EXPERIMENT_CONDITIONS = ["hoh", "vanilla", "no-plan-update", "no-evidence", "no-warm-start"] as const;
export type ExperimentCondition = (typeof EXPERIMENT_CONDITIONS)[number];

export type ExperimentBudgetUnit = "wall_clock_ms" | "total_tokens" | "cost_usd";

export interface ExperimentSample {
  readonly task_id: string;
  readonly sample_id: string;
}

export interface ExperimentCell {
  readonly id: string;
  readonly condition: ExperimentCondition;
}

export interface ExperimentBudget {
  readonly unit: ExperimentBudgetUnit;
  readonly limit: number;
}

export interface ExperimentEvaluator {
  /** Executable followed by exact arguments. This is never a shell command string. */
  readonly argv: readonly string[];
  readonly version: string;
  readonly rubric_sha256: string;
  /** Exact executable bytes expected immediately before and after the trusted evaluator run. */
  readonly executable_sha256: string;
}

export interface ExperimentRetryRules {
  /** Includes the first attempt. */
  readonly max_attempts: number;
  readonly retryable_failure_codes: readonly string[];
}

export interface ExperimentPlan {
  readonly samples: readonly ExperimentSample[];
  readonly repetitions: number;
  readonly assignment_seed: number;
  /** Exactly one cell for every condition in EXPERIMENT_CONDITIONS. */
  readonly cells: readonly ExperimentCell[];
  /** One shared definition applies to every cell and sample. */
  readonly budget: ExperimentBudget;
  readonly evaluator: ExperimentEvaluator;
  readonly metric: string;
  readonly aggregation: string;
  readonly uncertainty: string;
  readonly exclusion_rules: readonly string[];
  readonly retry: ExperimentRetryRules;
}

export type ExperimentAttemptStatus = "completed" | "failed" | "cancelled";

export interface ExperimentAttemptFailure {
  readonly code: string;
  readonly message: string;
}

export interface ExperimentAttemptRetry {
  /** One-based attempt number for this cell/sample/repetition tuple. */
  readonly attempt: number;
  /** Null for the first attempt; otherwise the immediately preceding attempt id. */
  readonly retry_of: string | null;
}

export interface ExperimentAttemptOutcome {
  readonly plan_sha256: string;
  readonly attempt_id: string;
  readonly cell_id: string;
  readonly task_id: string;
  readonly sample_id: string;
  /** One-based repetition index, bounded by plan.repetitions. */
  readonly repetition: number;
  readonly retry: ExperimentAttemptRetry;
  readonly run_receipt_sha256: string;
  readonly status: ExperimentAttemptStatus;
  readonly failure: ExperimentAttemptFailure | null;
  readonly valid: boolean;
  readonly invalid_reason: string | null;
}

export interface ExperimentManifest {
  readonly schema_version: 1;
  readonly plan: ExperimentPlan;
  readonly plan_sha256: string;
  readonly attempts: readonly ExperimentAttemptOutcome[];
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const CONDITIONS = new Set<string>(EXPERIMENT_CONDITIONS);
const BUDGET_UNITS = new Set<string>(["wall_clock_ms", "total_tokens", "cost_usd"] satisfies ExperimentBudgetUnit[]);
const ATTEMPT_STATUSES = new Set<string>(["completed", "failed", "cancelled"] satisfies ExperimentAttemptStatus[]);

/** Validate, detach, hash, and freeze a plan before any attempt exists. */
export function createExperimentManifest(value: unknown): ExperimentManifest {
  const plan = parsePlan(value, "plan");
  return freezeManifest({ schema_version: 1, plan, plan_sha256: canonicalSha256(plan), attempts: [] });
}

/** Strictly parse a serialized manifest, including its immutable plan hash and attempt chain. */
export function parseExperimentManifest(value: unknown): ExperimentManifest {
  const raw = record(value, "manifest");
  exactKeys(raw, ["schema_version", "plan", "plan_sha256", "attempts"], "manifest");
  if (raw.schema_version !== 1) fail("manifest.schema_version", "must be 1");
  const plan = parsePlan(raw.plan, "manifest.plan");
  const planSha256 = sha256(raw.plan_sha256, "manifest.plan_sha256");
  const actualPlanSha256 = canonicalSha256(plan);
  if (planSha256 !== actualPlanSha256) {
    fail("manifest.plan_sha256", `does not match the canonical plan (${planSha256} != ${actualPlanSha256})`);
  }
  if (!Array.isArray(raw.attempts)) fail("manifest.attempts", "must be an array");
  const attempts: ExperimentAttemptOutcome[] = [];
  for (let index = 0; index < raw.attempts.length; index += 1) {
    attempts.push(parseAttempt(raw.attempts[index], plan, planSha256, attempts, `manifest.attempts[${index}]`));
  }
  return freezeManifest({ schema_version: 1, plan, plan_sha256: planSha256, attempts });
}

/** Return a new frozen manifest with one validated outcome; the original manifest is unchanged. */
export function addExperimentAttempt(manifestValue: unknown, attemptValue: unknown): ExperimentManifest {
  const manifest = parseExperimentManifest(manifestValue);
  const attempt = parseAttempt(attemptValue, manifest.plan, manifest.plan_sha256, manifest.attempts, "attempt");
  return freezeManifest({ ...manifest, attempts: [...manifest.attempts, attempt] });
}

function parsePlan(value: unknown, at: string): ExperimentPlan {
  const raw = record(value, at);
  exactKeys(
    raw,
    [
      "samples",
      "repetitions",
      "assignment_seed",
      "cells",
      "budget",
      "evaluator",
      "metric",
      "aggregation",
      "uncertainty",
      "exclusion_rules",
      "retry",
    ],
    at,
  );

  if (!Array.isArray(raw.samples) || raw.samples.length === 0) fail(`${at}.samples`, "must be a non-empty array");
  const samples = raw.samples.map((sample, index) => parseSample(sample, `${at}.samples[${index}]`));
  const sampleKeys = new Set<string>();
  for (const sample of samples) {
    const key = `${sample.task_id}\u0000${sample.sample_id}`;
    if (sampleKeys.has(key)) fail(`${at}.samples`, `duplicates task/sample ${JSON.stringify(`${sample.task_id}/${sample.sample_id}`)}`);
    sampleKeys.add(key);
  }

  const repetitions = positiveSafeInteger(raw.repetitions, `${at}.repetitions`);
  const assignmentSeed = nonNegativeSafeInteger(raw.assignment_seed, `${at}.assignment_seed`);

  if (!Array.isArray(raw.cells)) fail(`${at}.cells`, "must be an array");
  const cells = raw.cells.map((cell, index) => parseCell(cell, `${at}.cells[${index}]`));
  const cellIds = new Set<string>();
  const conditions = new Set<ExperimentCondition>();
  for (const cell of cells) {
    if (cellIds.has(cell.id)) fail(`${at}.cells`, `duplicates cell id ${JSON.stringify(cell.id)}`);
    if (conditions.has(cell.condition)) fail(`${at}.cells`, `duplicates condition ${JSON.stringify(cell.condition)}`);
    cellIds.add(cell.id);
    conditions.add(cell.condition);
  }
  const missingConditions = EXPERIMENT_CONDITIONS.filter((condition) => !conditions.has(condition));
  if (missingConditions.length > 0 || cells.length !== EXPERIMENT_CONDITIONS.length) {
    fail(`${at}.cells`, `must contain exactly one cell for each condition: ${EXPERIMENT_CONDITIONS.join(", ")}`);
  }

  const budget = parseBudget(raw.budget, `${at}.budget`);
  const evaluator = parseEvaluator(raw.evaluator, `${at}.evaluator`);
  const metric = text(raw.metric, `${at}.metric`);
  const aggregation = text(raw.aggregation, `${at}.aggregation`);
  const uncertainty = text(raw.uncertainty, `${at}.uncertainty`);
  const exclusionRules = stringList(raw.exclusion_rules, `${at}.exclusion_rules`);
  const retry = parseRetryRules(raw.retry, `${at}.retry`);

  return {
    samples,
    repetitions,
    assignment_seed: assignmentSeed,
    cells,
    budget,
    evaluator,
    metric,
    aggregation,
    uncertainty,
    exclusion_rules: exclusionRules,
    retry,
  };
}

function parseSample(value: unknown, at: string): ExperimentSample {
  const raw = record(value, at);
  exactKeys(raw, ["task_id", "sample_id"], at);
  return { task_id: identifier(raw.task_id, `${at}.task_id`), sample_id: identifier(raw.sample_id, `${at}.sample_id`) };
}

function parseCell(value: unknown, at: string): ExperimentCell {
  const raw = record(value, at);
  exactKeys(raw, ["id", "condition"], at);
  const condition = text(raw.condition, `${at}.condition`);
  if (!CONDITIONS.has(condition)) fail(`${at}.condition`, `must be one of ${EXPERIMENT_CONDITIONS.join(", ")}`);
  return { id: identifier(raw.id, `${at}.id`), condition: condition as ExperimentCondition };
}

function parseBudget(value: unknown, at: string): ExperimentBudget {
  const raw = record(value, at);
  exactKeys(raw, ["unit", "limit"], at);
  const unit = text(raw.unit, `${at}.unit`);
  if (!BUDGET_UNITS.has(unit)) fail(`${at}.unit`, "must be wall_clock_ms, total_tokens, or cost_usd");
  const limit = raw.limit;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) fail(`${at}.limit`, "must be a finite number greater than zero");
  if ((unit === "wall_clock_ms" || unit === "total_tokens") && !Number.isSafeInteger(limit)) {
    fail(`${at}.limit`, `must be a positive safe integer for ${unit}`);
  }
  return { unit: unit as ExperimentBudgetUnit, limit };
}

function parseEvaluator(value: unknown, at: string): ExperimentEvaluator {
  const raw = record(value, at);
  exactKeys(raw, ["argv", "version", "rubric_sha256", "executable_sha256"], at);
  if (!Array.isArray(raw.argv) || raw.argv.length === 0) fail(`${at}.argv`, "must be a non-empty argv array");
  const argv = raw.argv.map((argument, index) => argumentText(argument, `${at}.argv[${index}]`));
  if (!path.isAbsolute(argv[0])) fail(`${at}.argv[0]`, "must be an absolute executable path");
  return {
    argv,
    version: text(raw.version, `${at}.version`),
    rubric_sha256: sha256(raw.rubric_sha256, `${at}.rubric_sha256`),
    executable_sha256: sha256(raw.executable_sha256, `${at}.executable_sha256`),
  };
}

function parseRetryRules(value: unknown, at: string): ExperimentRetryRules {
  const raw = record(value, at);
  exactKeys(raw, ["max_attempts", "retryable_failure_codes"], at);
  const maxAttempts = positiveSafeInteger(raw.max_attempts, `${at}.max_attempts`);
  const codes = stringList(raw.retryable_failure_codes, `${at}.retryable_failure_codes`);
  if (new Set(codes).size !== codes.length) fail(`${at}.retryable_failure_codes`, "must not contain duplicates");
  if (maxAttempts > 1 && codes.length === 0) fail(`${at}.retryable_failure_codes`, "must name at least one code when retries are enabled");
  return { max_attempts: maxAttempts, retryable_failure_codes: codes };
}

function parseAttempt(
  value: unknown,
  plan: ExperimentPlan,
  planSha256: string,
  priorAttempts: readonly ExperimentAttemptOutcome[],
  at: string,
): ExperimentAttemptOutcome {
  const raw = record(value, at);
  exactKeys(
    raw,
    [
      "plan_sha256",
      "attempt_id",
      "cell_id",
      "task_id",
      "sample_id",
      "repetition",
      "retry",
      "run_receipt_sha256",
      "status",
      "failure",
      "valid",
      "invalid_reason",
    ],
    at,
  );

  const attemptPlanSha256 = sha256(raw.plan_sha256, `${at}.plan_sha256`);
  if (attemptPlanSha256 !== planSha256) fail(`${at}.plan_sha256`, `must equal manifest.plan_sha256 ${planSha256}`);
  const attemptId = identifier(raw.attempt_id, `${at}.attempt_id`);
  if (priorAttempts.some((attempt) => attempt.attempt_id === attemptId)) fail(`${at}.attempt_id`, `duplicates ${JSON.stringify(attemptId)}`);
  const cellId = identifier(raw.cell_id, `${at}.cell_id`);
  if (!plan.cells.some((cell) => cell.id === cellId)) fail(`${at}.cell_id`, `does not name a plan cell: ${JSON.stringify(cellId)}`);
  const taskId = identifier(raw.task_id, `${at}.task_id`);
  const sampleId = identifier(raw.sample_id, `${at}.sample_id`);
  if (!plan.samples.some((sample) => sample.task_id === taskId && sample.sample_id === sampleId)) {
    fail(`${at}.sample_id`, `does not name a planned task/sample: ${JSON.stringify(`${taskId}/${sampleId}`)}`);
  }
  const repetition = positiveSafeInteger(raw.repetition, `${at}.repetition`);
  if (repetition > plan.repetitions) fail(`${at}.repetition`, `must not exceed plan.repetitions (${plan.repetitions})`);

  const retryRaw = record(raw.retry, `${at}.retry`);
  exactKeys(retryRaw, ["attempt", "retry_of"], `${at}.retry`);
  const attemptNumber = positiveSafeInteger(retryRaw.attempt, `${at}.retry.attempt`);
  if (attemptNumber > plan.retry.max_attempts) {
    fail(`${at}.retry.attempt`, `must not exceed plan.retry.max_attempts (${plan.retry.max_attempts})`);
  }
  const retryOf = retryRaw.retry_of === null ? null : identifier(retryRaw.retry_of, `${at}.retry.retry_of`);
  const tuple = (attempt: ExperimentAttemptOutcome) =>
    attempt.cell_id === cellId && attempt.task_id === taskId && attempt.sample_id === sampleId && attempt.repetition === repetition;
  if (priorAttempts.some((attempt) => tuple(attempt) && attempt.retry.attempt === attemptNumber)) {
    fail(`${at}.retry.attempt`, `duplicates attempt ${attemptNumber} for this cell/task/sample/repetition`);
  }
  if (attemptNumber === 1) {
    if (retryOf !== null) fail(`${at}.retry.retry_of`, "must be null for the first attempt");
  } else {
    if (retryOf === null) fail(`${at}.retry.retry_of`, "must reference the immediately preceding attempt");
    const prior = priorAttempts.find((attempt) => attempt.attempt_id === retryOf);
    if (!prior || !tuple(prior) || prior.retry.attempt !== attemptNumber - 1) {
      fail(`${at}.retry.retry_of`, "must reference attempt N-1 for the same cell/task/sample/repetition");
    }
    if (prior.status === "completed" || !prior.failure) fail(`${at}.retry.retry_of`, "may only retry a failed or cancelled attempt");
    if (!plan.retry.retryable_failure_codes.includes(prior.failure.code)) {
      fail(`${at}.retry.retry_of`, `prior failure code ${JSON.stringify(prior.failure.code)} is not retryable`);
    }
  }

  const runReceiptSha256 = sha256(raw.run_receipt_sha256, `${at}.run_receipt_sha256`);
  const status = text(raw.status, `${at}.status`);
  if (!ATTEMPT_STATUSES.has(status)) fail(`${at}.status`, "must be completed, failed, or cancelled");
  const failure = raw.failure === null ? null : parseFailure(raw.failure, `${at}.failure`);
  if (status === "completed" && failure !== null) fail(`${at}.failure`, "must be null when status is completed");
  if (status !== "completed" && failure === null) fail(`${at}.failure`, `is required when status is ${status}`);
  if (typeof raw.valid !== "boolean") fail(`${at}.valid`, "must be a boolean");
  const valid = raw.valid;
  const invalidReason = raw.invalid_reason === null ? null : text(raw.invalid_reason, `${at}.invalid_reason`);
  if (valid && invalidReason !== null) fail(`${at}.invalid_reason`, "must be null for a valid attempt");
  if (!valid && invalidReason === null) fail(`${at}.invalid_reason`, "is required for an invalid attempt");
  if (valid && status !== "completed") fail(`${at}.valid`, "only a completed attempt can be valid");

  return {
    plan_sha256: attemptPlanSha256,
    attempt_id: attemptId,
    cell_id: cellId,
    task_id: taskId,
    sample_id: sampleId,
    repetition,
    retry: { attempt: attemptNumber, retry_of: retryOf },
    run_receipt_sha256: runReceiptSha256,
    status: status as ExperimentAttemptStatus,
    failure,
    valid,
    invalid_reason: invalidReason,
  };
}

function parseFailure(value: unknown, at: string): ExperimentAttemptFailure {
  const raw = record(value, at);
  exactKeys(raw, ["code", "message"], at);
  return { code: identifier(raw.code, `${at}.code`), message: text(raw.message, `${at}.message`) };
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(at, "must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], at: string): void {
  const allowed = new Set(keys);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0) fail(at, `is missing ${missing.join(", ")}`);
  if (unknown.length > 0) fail(at, `has unknown field(s): ${unknown.join(", ")}`);
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || !value.trim() || /\0/.test(value)) fail(at, "must be a non-empty string without NUL bytes");
  return value;
}

function identifier(value: unknown, at: string): string {
  const result = text(value, at);
  if (result !== result.trim() || /[\r\n]/.test(result)) fail(at, "must not have surrounding whitespace or line breaks");
  return result;
}

function argumentText(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0 || /\0/.test(value)) fail(at, "must be a non-empty string without NUL bytes");
  return value;
}

function stringList(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) fail(at, "must be an array");
  return value.map((item, index) => text(item, `${at}[${index}]`));
}

function positiveSafeInteger(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(at, "must be a positive safe integer");
  return value;
}

function nonNegativeSafeInteger(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(at, "must be a non-negative safe integer");
  return value;
}

function sha256(value: unknown, at: string): string {
  if (typeof value !== "string" || !HEX_SHA256.test(value)) fail(at, "must be a lowercase 64-character SHA-256 hex digest");
  return value;
}

function freezeManifest(value: ExperimentManifest): ExperimentManifest {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

function fail(at: string, message: string): never {
  throw new Error(`invalid experiment manifest: ${at} ${message}`);
}
