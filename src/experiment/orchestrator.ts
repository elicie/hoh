/** Pre-register, execute, receipt, and aggregate paper experiment attempts. */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Harness } from "../harness/types.js";
import { assertValidConfig, type BudgetConfig, type ConfigPatch, DEFAULT_CONFIG, type HohConfig, mergeConfig } from "../runtime/config.js";
import { artifactTreeHash, ensureRepo, git, headCommit } from "../runtime/git.js";
import { assertProtocolReceiptIntegrity, canonicalJson, canonicalSha256 } from "../runtime/protocol.js";
import { parseRunReceipt, serializeRunReceipt, type RunReceipt } from "../runtime/receipt.js";
import { RunPaths } from "../runtime/state.js";
import { verifyCurrentRunReceipt } from "../runtime/run-receipt.js";
import type { ProtocolReceipt } from "../types.js";
import {
  aggregateExperimentResults,
  createRawExperimentResult,
  evaluatorReceiptSha256,
  parseRawExperimentResultsJsonl,
  serializeExperimentAggregateSummary,
  serializeRawExperimentResultsJsonl,
  type EvaluatorReceiptSource,
  type ExperimentAggregateSummary,
  type RawExperimentResult,
} from "./aggregate.js";
import {
  buildExperimentProtocolReceipt,
  EXPERIMENT_CONDITION_POLICY_VERSION,
  EXPERIMENT_CONDITION_RECORD,
  parseExperimentConditionRecord,
  runExperimentCondition,
  type ExperimentConditionRecord,
  type ExperimentConditionResult,
} from "./conditions.js";
import {
  EVALUATOR_LIMITS,
  EvaluatorRunError,
  runBlindEvaluator,
  type BlindEvaluatorDefinition,
  type EvaluatorReceipt,
} from "./evaluator.js";
import {
  addExperimentAttempt,
  createExperimentManifest,
  EXPERIMENT_ARTIFACT_PACKAGER,
  EXPERIMENT_CONDITIONS,
  parseExperimentManifest,
  type ExperimentAttemptOutcome,
  type ExperimentBudget,
  type ExperimentCell,
  type ExperimentCondition,
  type ExperimentEvaluator,
  type ExperimentManifest,
  type ExperimentRetryRules,
} from "./manifest.js";

export const EXPERIMENT_MANIFEST_FILE = "manifest.json";
export const EXPERIMENT_RAW_RESULTS_FILE = "raw-results.jsonl";
export const EXPERIMENT_AGGREGATE_FILE = "aggregate.json";
export const EXPERIMENT_COMPLETE_FILE = "complete.json";
export const EXPERIMENT_RECEIPTS_DIR = "receipts";
export const EXPERIMENT_INTENTS_DIR = "intents";
const EXPERIMENT_LOCK_FILE = ".orchestrator.lock";
const ARTIFACT_PACKAGER = EXPERIMENT_ARTIFACT_PACKAGER;
const ARCHIVE_MTIME = "1970-01-01T00:00:00Z";
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_STATE_FILE_BYTES = 32 * 1024 * 1024;
const EXPERIMENT_ENV_KEYS = [
  "HOH_WORKSPACE",
  "HOH_RUN_ID",
  "HOH_LOOP",
  "HOH_ROLE",
  "HOH_CANDIDATE_DIR",
  "HOH_EVIDENCE_DIR",
] as const;
let experimentExecutionActive = false;

export interface ExperimentRegistrationSample {
  readonly task_id: string;
  readonly sample_id: string;
  /** A pristine product workspace used only to hash the common A0. */
  readonly workspace: string;
  readonly spec_path: string;
  /** Exact text later disclosed to the external evaluator as its task. */
  readonly evaluator_task: string;
  /** Exact sample input later disclosed to the external evaluator. */
  readonly evaluator_sample: string;
}

export interface RegisterExperimentRequest {
  readonly experiment_root: string;
  readonly samples: readonly ExperimentRegistrationSample[];
  readonly repetitions: number;
  readonly assignment_seed: number;
  readonly budget: ExperimentBudget;
  readonly evaluator: ExperimentEvaluator;
  readonly metric: string;
  readonly exclusion_rules: readonly string[];
  readonly retry: ExperimentRetryRules;
  readonly harness: Harness;
  readonly config: ConfigPatch;
}

export interface ExperimentAssignment {
  readonly cell_id: string;
  readonly condition: ExperimentCondition;
  readonly task_id: string;
  readonly sample_id: string;
  readonly repetition: number;
}

export interface RunExperimentAttemptRequest {
  readonly experiment_root: string;
  readonly attempt_id: string;
  readonly cell_id: string;
  readonly task_id: string;
  readonly sample_id: string;
  readonly repetition: number;
  readonly retry?: { readonly attempt: number; readonly retry_of: string | null };
  /** A fresh copy of the sample's pre-registered A0. */
  readonly workspace: string;
  readonly spec_path: string;
  readonly evaluator_task: string;
  readonly evaluator_sample: string;
  readonly harness: Harness;
  readonly config: ConfigPatch;
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
}

export interface ExperimentAttemptResult {
  readonly manifest: ExperimentManifest;
  readonly attempt: ExperimentAttemptOutcome;
  readonly condition_result: ExperimentConditionResult;
  readonly evaluator_receipt: EvaluatorReceipt | null;
  readonly raw_result: RawExperimentResult | null;
}

interface LoadedExperimentState {
  readonly manifest: ExperimentManifest;
  readonly rawResults: readonly RawExperimentResult[];
  readonly receiptSources: readonly EvaluatorReceiptSource[];
}

/**
 * Freeze the complete experiment definition before any development role runs.
 * Cell ids intentionally equal condition names; this removes an unnecessary
 * caller-controlled label while retaining a stable manifest coordinate.
 */
export async function registerExperiment(request: RegisterExperimentRequest): Promise<ExperimentManifest> {
  if (!Array.isArray(request.samples) || request.samples.length === 0) {
    throw new Error("experiment registration requires at least one sample");
  }
  const root = path.resolve(request.experiment_root);
  await prepareEmptyExperimentRoot(root);

  const config = effectiveExperimentConfig(request.config, request.budget);
  const protocols = await resolveCellProtocols(config, request.harness);
  const reference = protocols[0].receipt;
  const resolvedModel = commonResolvedModel(reference);
  await assertEvaluatorExecutableIdentity(request.evaluator);

  const samples = [];
  for (const sample of request.samples) {
    const workspace = path.resolve(sample.workspace);
    await assertDisjointPaths(root, workspace, "experiment root", "registration workspace");
    await ensureRepo(workspace);
    const spec = await readBoundedFile(path.resolve(sample.spec_path), EVALUATOR_LIMITS.task_bytes, "sample specification");
    const evaluatorTask = boundedUtf8(sample.evaluator_task, EVALUATOR_LIMITS.task_bytes, "evaluator task");
    const evaluatorSample = boundedUtf8(sample.evaluator_sample, EVALUATOR_LIMITS.sample_bytes, "evaluator sample");
    samples.push({
      task_id: sample.task_id,
      sample_id: sample.sample_id,
      spec_sha256: sha256(spec),
      evaluator_task_sha256: sha256(evaluatorTask),
      evaluator_sample_sha256: sha256(evaluatorSample),
      a0: {
        workspace_tree_oid: await artifactTreeHash(workspace, { subdir: "." }),
        artifact_tree_oid: await artifactTreeHash(workspace, { subdir: config.artifact_dir }),
      },
    });
  }

  const cells: ExperimentCell[] = protocols.map(({ condition, receipt }) => ({
    id: condition,
    condition,
    protocol_sha256: receipt.protocol_sha256,
  }));
  const manifest = createExperimentManifest({
    execution: {
      config_sha256: canonicalSha256(config),
      loops: config.loops,
      artifact_dir: config.artifact_dir,
      artifact_packager: ARTIFACT_PACKAGER,
      harness: structuredClone(reference.harness),
      resolved_model: resolvedModel,
      condition_policy_version: EXPERIMENT_CONDITION_POLICY_VERSION,
    },
    samples,
    repetitions: request.repetitions,
    assignment_seed: request.assignment_seed,
    cells,
    budget: request.budget,
    evaluator: request.evaluator,
    metric: request.metric,
    aggregation: "macro_mean",
    uncertainty: "bootstrap_95_ci",
    exclusion_rules: request.exclusion_rules,
    retry: request.retry,
  });

  await mkdir(path.join(root, EXPERIMENT_RECEIPTS_DIR), { mode: 0o700 });
  await mkdir(path.join(root, EXPERIMENT_INTENTS_DIR), { mode: 0o700 });
  await writeExclusiveFile(path.join(root, EXPERIMENT_RAW_RESULTS_FILE), "");
  await writeExclusiveFile(path.join(root, EXPERIMENT_MANIFEST_FILE), `${canonicalJson(manifest)}\n`);
  const stored = parseExperimentManifest(await readJsonFile(path.join(root, EXPERIMENT_MANIFEST_FILE), "stored experiment manifest"));
  if (canonicalJson(stored) !== canonicalJson(manifest)) throw new Error("stored experiment manifest differs from the registered plan");
  return stored;
}

/** Return every planned coordinate in a deterministic seed-derived order. */
export function experimentAssignments(manifestValue: unknown): readonly ExperimentAssignment[] {
  const manifest = parseExperimentManifest(manifestValue);
  const assignments: ExperimentAssignment[] = [];
  for (const cell of manifest.plan.cells) {
    for (const sample of manifest.plan.samples) {
      for (let repetition = 1; repetition <= manifest.plan.repetitions; repetition += 1) {
        assignments.push({
          cell_id: cell.id,
          condition: cell.condition,
          task_id: sample.task_id,
          sample_id: sample.sample_id,
          repetition,
        });
      }
    }
  }
  return Object.freeze(
    assignments.sort((left, right) => {
      const leftKey = assignmentKey(manifest, left);
      const rightKey = assignmentKey(manifest, right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : coordinateKey(left).localeCompare(coordinateKey(right));
    }),
  );
}

/**
 * Execute one manifest coordinate. The development condition completes and is
 * verified before a deterministic artifact archive reaches the blind evaluator.
 */
export async function runExperimentAttempt(request: RunExperimentAttemptRequest): Promise<ExperimentAttemptResult> {
  const root = path.resolve(request.experiment_root);
  const workspace = path.resolve(request.workspace);
  await assertDisjointPaths(root, workspace, "experiment root", "run workspace");
  return withGlobalExperimentExecutionGuard(() => withExperimentLock(root, async () => {
    request.signal?.throwIfAborted();
    const state = await loadExperimentState(root);
    const manifest = state.manifest;
    if (await exists(path.join(root, EXPERIMENT_COMPLETE_FILE))) {
      throw new Error("the completed experiment is sealed; no further attempts may be appended");
    }
    const cell = requireCell(manifest, request.cell_id);
    const sample = requireSample(manifest, request.task_id, request.sample_id);
    assertAttemptCoordinateAvailable(manifest, request);

    const config = effectiveExperimentConfig(request.config, manifest.plan.budget);
    await assertExecutionBinding(manifest, config, request.harness, cell);
    await assertEvaluatorExecutableIdentity(manifest.plan.evaluator);
    await assertSampleBinding(sample, workspace, request.spec_path, request.evaluator_task, request.evaluator_sample, config.artifact_dir);

    const protocolReceipt = await buildExperimentProtocolReceipt(config, request.harness, cell.condition);
    if (protocolReceipt.protocol_sha256 !== cell.protocol_sha256) {
      throw new Error("current condition protocol does not match its pre-registered cell protocol");
    }
    const intentPath = await createAttemptIntent(root, manifest, request, cell);

    const conditionResult = await runExperimentCondition({
      condition: cell.condition,
      workspace,
      specPath: request.spec_path,
      harness: request.harness,
      config,
      binding: {
        plan_sha256: manifest.plan_sha256,
        attempt_id: request.attempt_id,
        cell_id: cell.id,
      },
      signal: request.signal,
      log: request.log,
    });

    const conditionRecord = await verifyConditionResult(
      manifest,
      sample,
      cell,
      config,
      protocolReceipt,
      workspace,
      request,
      conditionResult,
    );

    if (conditionResult.status === "budget_exhausted") {
      const persisted = await persistExcludedAttempt({
        root,
        state,
        request,
        cell,
        conditionResult,
        conditionRecord,
        protocolReceipt,
        code: "budget_exhausted",
        message: "the pre-registered common run budget was exhausted before completion",
        evaluatorReceipt: null,
      });
      await completeAttemptIntent(intentPath);
      return persisted;
    }

    let evaluatorReceipt: EvaluatorReceipt;
    const postConditionHead = await headCommit(workspace);
    const postConditionTree = await artifactTreeHash(workspace, { subdir: "." });
    const temporary = await mkdtemp(path.join(os.tmpdir(), "hoh-experiment-artifact-"));
    try {
      const archive = path.join(temporary, "artifact.tar");
      await createDeterministicArtifactArchive(workspace, conditionResult.final_artifact.tree_oid, archive);
      const archiveBytes = await readBoundedFile(archive, EVALUATOR_LIMITS.artifact_bytes, "deterministic artifact archive");
      const archiveIdentity = { bytes: archiveBytes.byteLength, sha256: sha256(archiveBytes) };
      try {
        evaluatorReceipt = await runBlindEvaluator({
          evaluator: manifest.plan.evaluator,
          artifactPath: archive,
          task: request.evaluator_task,
          sample: request.evaluator_sample,
          signal: request.signal,
          private_values: evaluatorPrivateValues(manifest, request, cell, conditionResult, root, workspace),
        });
      } catch (error) {
        if (!(error instanceof EvaluatorRunError)) throw error;
        if (error.receipt) assertEvaluatorReceiptInput(error.receipt, sample, archiveIdentity);
        await assertEvaluatorDidNotMutateWorkspace(
          workspace,
          postConditionHead,
          postConditionTree,
          conditionResult.run_receipt_sha256,
        );
        const persisted = await persistExcludedAttempt({
          root,
          state,
          request,
          cell,
          conditionResult,
          conditionRecord,
          protocolReceipt,
          code: error.code,
          message: error.message,
          evaluatorReceipt: error.receipt ?? null,
        });
        await completeAttemptIntent(intentPath);
        return persisted;
      }
      assertEvaluatorReceiptInput(evaluatorReceipt, sample, archiveIdentity);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    await assertEvaluatorDidNotMutateWorkspace(workspace, postConditionHead, postConditionTree, conditionResult.run_receipt_sha256);

    const evaluatorHash = evaluatorReceiptSha256(evaluatorReceipt);
    const attempt = createAttemptOutcome(manifest, request, cell, conditionResult, {
      status: "completed",
      failure: null,
      valid: true,
      invalid_reason: null,
      evaluator_receipt_sha256: evaluatorHash,
    });
    const nextManifest = addExperimentAttempt(manifest, attempt);
    const evaluatorPath = evaluatorReceiptRelativePath(request.attempt_id);
    const raw = createRawExperimentResult({
      manifest: nextManifest,
      attemptId: request.attempt_id,
      evaluatorReceipt,
      evaluatorReceiptPath: evaluatorPath,
    });
    const nextSources = [...state.receiptSources, { path: evaluatorPath, receipt: evaluatorReceipt }];
    const nextRaw = [...state.rawResults, raw];
    await persistAttemptState({
      root,
      priorManifest: manifest,
      nextManifest,
      nextRaw,
      nextSources,
      attempt,
      conditionRecord,
      protocolReceipt,
      runReceipt: conditionResult.run_receipt,
      evaluatorReceipt,
    });
    await completeAttemptIntent(intentPath);
    return {
      manifest: nextManifest,
      attempt: nextManifest.attempts[nextManifest.attempts.length - 1],
      condition_result: conditionResult,
      evaluator_receipt: evaluatorReceipt,
      raw_result: raw,
    };
  }));
}

/** Verify the preserved raw stream and write its deterministic aggregate view. */
export async function aggregateExperimentDirectory(experimentRoot: string): Promise<ExperimentAggregateSummary> {
  const root = path.resolve(experimentRoot);
  return withExperimentLock(root, async () => {
    const state = await loadExperimentState(root);
    const summary = aggregateExperimentResults(state.manifest, state.rawResults, state.receiptSources);
    const aggregateText = serializeExperimentAggregateSummary(summary);
    const rawText = serializeRawExperimentResultsJsonl(state.rawResults, state.manifest, state.receiptSources);
    await writeAtomicFile(path.join(root, EXPERIMENT_AGGREGATE_FILE), aggregateText);
    const completionPayload = {
      schema_version: 1 as const,
      plan_sha256: state.manifest.plan_sha256,
      manifest_sha256: canonicalSha256(state.manifest),
      raw_results_sha256: sha256(Buffer.from(rawText, "utf8")),
      aggregate_sha256: sha256(Buffer.from(aggregateText, "utf8")),
      attempt_count: state.manifest.attempts.length,
    };
    await writeAtomicFile(
      path.join(root, EXPERIMENT_COMPLETE_FILE),
      `${canonicalJson({ ...completionPayload, complete_sha256: canonicalSha256(completionPayload) })}\n`,
    );
    return summary;
  });
}

function effectiveExperimentConfig(patch: ConfigPatch, budget: ExperimentBudget): HohConfig {
  const expected = experimentBudgetConfig(budget);
  if (Object.prototype.hasOwnProperty.call(patch, "budgets") && canonicalJson(patch.budgets) !== canonicalJson(expected)) {
    throw new Error("experiment config budgets must contain only the exact pre-registered run limit");
  }
  const config = mergeConfig(DEFAULT_CONFIG, { ...patch, budgets: expected });
  assertValidConfig(config, "experiment orchestration");
  if (config.protocol !== "paper") throw new Error('experiment orchestration requires config.protocol "paper"');
  return config;
}

function experimentBudgetConfig(budget: ExperimentBudget): BudgetConfig {
  switch (budget.unit) {
    case "wall_clock_ms":
      return { run: { elapsed_ms: budget.limit } };
    case "total_tokens":
      return { run: { total_tokens: budget.limit } };
    case "cost_usd":
      return { run: { cost: budget.limit } };
  }
}

async function resolveCellProtocols(
  config: HohConfig,
  harness: Harness,
): Promise<readonly { condition: ExperimentCondition; receipt: ProtocolReceipt }[]> {
  const protocols = [];
  for (const condition of EXPERIMENT_CONDITIONS) {
    protocols.push({ condition, receipt: await buildExperimentProtocolReceipt(config, harness, condition) });
  }
  const reference = protocols[0].receipt;
  for (const { receipt } of protocols) {
    if (
      receipt.config_sha256 !== reference.config_sha256 ||
      canonicalJson(receipt.harness) !== canonicalJson(reference.harness) ||
      canonicalJson(receipt.models) !== canonicalJson(reference.models)
    ) {
      throw new Error("all experiment cells must resolve the same config, harness version, and model identity");
    }
  }
  return protocols;
}

function commonResolvedModel(receipt: ProtocolReceipt): string {
  const models = Object.values(receipt.models);
  if (models.some((model) => typeof model !== "string" || !model)) {
    throw new Error("paper experiment requires a concrete resolved model identity for every role");
  }
  if (new Set(models).size !== 1) throw new Error("paper experiment requires one common resolved model identity");
  return models[0] as string;
}

async function assertExecutionBinding(
  manifest: ExperimentManifest,
  config: HohConfig,
  harness: Harness,
  cell: ExperimentCell,
): Promise<void> {
  const execution = manifest.plan.execution;
  if (execution.condition_policy_version !== EXPERIMENT_CONDITION_POLICY_VERSION) {
    throw new Error("manifest condition policy version does not match this runtime");
  }
  if (execution.artifact_packager !== ARTIFACT_PACKAGER) throw new Error("unsupported experiment artifact packager");
  if (execution.config_sha256 !== canonicalSha256(config)) throw new Error("current config does not match the pre-registered config");
  if (execution.loops !== config.loops) throw new Error("current loop count does not match the pre-registered execution");
  if (execution.artifact_dir !== config.artifact_dir) throw new Error("current artifact_dir does not match the pre-registered execution");
  const protocol = await buildExperimentProtocolReceipt(config, harness, cell.condition);
  if (protocol.protocol_sha256 !== cell.protocol_sha256) throw new Error("current protocol does not match the pre-registered cell");
  if (canonicalJson(protocol.harness) !== canonicalJson(execution.harness)) {
    throw new Error("current harness identity does not match the pre-registered execution");
  }
  if (commonResolvedModel(protocol) !== execution.resolved_model) {
    throw new Error("current resolved model does not match the pre-registered execution");
  }
}

async function assertSampleBinding(
  sample: ExperimentManifest["plan"]["samples"][number],
  workspace: string,
  specPath: string,
  evaluatorTask: string,
  evaluatorSample: string,
  artifactDir: string,
): Promise<void> {
  await ensureRepo(workspace);
  const spec = await readBoundedFile(path.resolve(specPath), EVALUATOR_LIMITS.task_bytes, "sample specification");
  const task = boundedUtf8(evaluatorTask, EVALUATOR_LIMITS.task_bytes, "evaluator task");
  const sampleBytes = boundedUtf8(evaluatorSample, EVALUATOR_LIMITS.sample_bytes, "evaluator sample");
  const actual = {
    spec_sha256: sha256(spec),
    evaluator_task_sha256: sha256(task),
    evaluator_sample_sha256: sha256(sampleBytes),
    workspace_tree_oid: await artifactTreeHash(workspace, { subdir: "." }),
    artifact_tree_oid: await artifactTreeHash(workspace, { subdir: artifactDir }),
  };
  if (actual.spec_sha256 !== sample.spec_sha256) throw new Error("sample specification does not match the pre-registered digest");
  if (actual.evaluator_task_sha256 !== sample.evaluator_task_sha256) throw new Error("evaluator task does not match the pre-registered digest");
  if (actual.evaluator_sample_sha256 !== sample.evaluator_sample_sha256) throw new Error("evaluator sample does not match the pre-registered digest");
  if (actual.workspace_tree_oid !== sample.a0.workspace_tree_oid) throw new Error("run workspace does not match the pre-registered A0 product tree");
  if (actual.artifact_tree_oid !== sample.a0.artifact_tree_oid) throw new Error("run artifact does not match the pre-registered A0 artifact tree");
}

async function verifyConditionResult(
  manifest: ExperimentManifest,
  sample: ExperimentManifest["plan"]["samples"][number],
  cell: ExperimentCell,
  config: HohConfig,
  protocol: ProtocolReceipt,
  workspace: string,
  request: RunExperimentAttemptRequest,
  result: ExperimentConditionResult,
): Promise<ExperimentConditionRecord> {
  const raw = JSON.parse(await readBoundedFile(path.join(workspace, EXPERIMENT_CONDITION_RECORD), MAX_STATE_FILE_BYTES, "condition receipt").then(String));
  const record = parseExperimentConditionRecord(raw);
  if (
    record.binding.plan_sha256 !== manifest.plan_sha256 ||
    record.binding.attempt_id !== request.attempt_id ||
    record.binding.cell_id !== cell.id ||
    record.condition !== cell.condition
  ) {
    throw new Error("condition receipt does not match the manifest attempt coordinate");
  }
  if (
    record.a0.workspace_tree_oid !== sample.a0.workspace_tree_oid ||
    record.a0.tree_oid !== sample.a0.artifact_tree_oid ||
    record.a0.subdir !== config.artifact_dir
  ) {
    throw new Error("condition receipt A0 does not match the pre-registered sample");
  }
  if (
    record.common.effective_config_sha256 !== manifest.plan.execution.config_sha256 ||
    record.common.protocol_sha256 !== cell.protocol_sha256 ||
    result.protocol_receipt_sha256 !== cell.protocol_sha256 ||
    result.condition_contract_sha256 !== record.condition_contract_sha256 ||
    result.run_receipt_sha256 !== result.run_receipt.receipt_sha256
  ) {
    throw new Error("condition result identities do not match the pre-registered execution");
  }
  if (protocol.protocol_sha256 !== record.common.protocol_sha256) throw new Error("condition protocol receipt mismatch");
  const verified = await verifyCurrentRunReceipt(workspace);
  if (!verified.ok || !verified.receipt) {
    throw new Error(`condition run receipt failed final verification: ${verified.issues.map((issue) => issue.code).join(", ")}`);
  }
  if (
    verified.receipt.receipt_sha256 !== result.run_receipt_sha256 ||
    canonicalJson(verified.receipt) !== canonicalJson(result.run_receipt)
  ) {
    throw new Error("condition result run receipt differs from the verified on-disk receipt");
  }
  if (!result.final_artifact || !GIT_OID.test(result.final_artifact.tree_oid)) {
    throw new Error("completed condition did not produce a full candidate tree identity");
  }
  if (result.status === "completed") {
    if (
      !result.run_receipt.candidate ||
      canonicalJson(result.run_receipt.candidate) !== canonicalJson(result.final_artifact)
    ) {
      throw new Error("condition final artifact does not match the verified run receipt candidate");
    }
  } else if (
    result.run_receipt.candidate !== null &&
    canonicalJson(result.run_receipt.candidate) !== canonicalJson(result.final_artifact)
  ) {
    throw new Error("budget-exhausted condition artifact does not match its last verified candidate");
  }
  const paths = new RunPaths(workspace);
  const storedConfig = await readJsonFile(paths.config, "condition config");
  if (canonicalSha256(storedConfig) !== canonicalSha256(config)) {
    throw new Error("condition stored config does not match the pre-registered effective config");
  }
  const storedBudget = await readJsonFile(paths.budget, "condition budget ledger");
  if (canonicalJson(storedBudget.limits) !== canonicalJson(config.budgets ?? {})) {
    throw new Error("condition budget ledger does not preserve the pre-registered common run limit");
  }
  return record;
}

function createAttemptOutcome(
  manifest: ExperimentManifest,
  request: RunExperimentAttemptRequest,
  cell: ExperimentCell,
  result: ExperimentConditionResult,
  outcome: Pick<
    ExperimentAttemptOutcome,
    "status" | "failure" | "valid" | "invalid_reason" | "evaluator_receipt_sha256"
  >,
): ExperimentAttemptOutcome {
  return {
    plan_sha256: manifest.plan_sha256,
    attempt_id: request.attempt_id,
    cell_id: cell.id,
    task_id: request.task_id,
    sample_id: request.sample_id,
    repetition: request.repetition,
    retry: request.retry ?? { attempt: 1, retry_of: null },
    condition_contract_sha256: result.condition_contract_sha256,
    protocol_receipt_sha256: result.protocol_receipt_sha256 ?? cell.protocol_sha256,
    run_receipt_sha256: result.run_receipt_sha256,
    ...outcome,
  };
}

async function persistExcludedAttempt(options: {
  root: string;
  state: LoadedExperimentState;
  request: RunExperimentAttemptRequest;
  cell: ExperimentCell;
  conditionResult: ExperimentConditionResult;
  conditionRecord: ExperimentConditionRecord;
  protocolReceipt: ProtocolReceipt;
  code: string;
  message: string;
  evaluatorReceipt: EvaluatorReceipt | null;
}): Promise<ExperimentAttemptResult> {
  if (!options.state.manifest.plan.exclusion_rules.includes(options.code)) {
    throw new Error(`attempt failed with ${JSON.stringify(options.code)}, which was not a pre-registered exclusion rule`);
  }
  const evaluatorHash = options.evaluatorReceipt ? evaluatorReceiptSha256(options.evaluatorReceipt) : null;
  const attempt = createAttemptOutcome(options.state.manifest, options.request, options.cell, options.conditionResult, {
    status: options.code === "cancelled" ? "cancelled" : "failed",
    failure: { code: options.code, message: options.message },
    valid: false,
    invalid_reason: options.code,
    evaluator_receipt_sha256: evaluatorHash,
  });
  const nextManifest = addExperimentAttempt(options.state.manifest, attempt);
  let raw: RawExperimentResult | null = null;
  let nextRaw = [...options.state.rawResults];
  let nextSources = [...options.state.receiptSources];
  if (options.evaluatorReceipt) {
    const evaluatorPath = evaluatorReceiptRelativePath(options.request.attempt_id);
    raw = createRawExperimentResult({
      manifest: nextManifest,
      attemptId: options.request.attempt_id,
      evaluatorReceipt: options.evaluatorReceipt,
      evaluatorReceiptPath: evaluatorPath,
    });
    nextRaw.push(raw);
    nextSources.push({ path: evaluatorPath, receipt: options.evaluatorReceipt });
  }
  await persistAttemptState({
    root: options.root,
    priorManifest: options.state.manifest,
    nextManifest,
    nextRaw,
    nextSources,
    attempt,
    conditionRecord: options.conditionRecord,
    protocolReceipt: options.protocolReceipt,
    runReceipt: options.conditionResult.run_receipt,
    evaluatorReceipt: options.evaluatorReceipt,
  });
  return {
    manifest: nextManifest,
    attempt: nextManifest.attempts[nextManifest.attempts.length - 1],
    condition_result: options.conditionResult,
    evaluator_receipt: options.evaluatorReceipt,
    raw_result: raw,
  };
}

async function persistAttemptState(options: {
  root: string;
  priorManifest: ExperimentManifest;
  nextManifest: ExperimentManifest;
  nextRaw: readonly RawExperimentResult[];
  nextSources: readonly EvaluatorReceiptSource[];
  attempt: ExperimentAttemptOutcome;
  conditionRecord: ExperimentConditionRecord;
  protocolReceipt: ProtocolReceipt;
  runReceipt: RunReceipt;
  evaluatorReceipt: EvaluatorReceipt | null;
}): Promise<void> {
  if (options.nextManifest.attempts.length !== options.priorManifest.attempts.length + 1) {
    throw new Error("attempt persistence requires exactly one append-only manifest outcome");
  }
  const receiptsRoot = path.join(options.root, EXPERIMENT_RECEIPTS_DIR);
  const finalDirectory = path.join(receiptsRoot, attemptReceiptDirectory(options.attempt.attempt_id));
  if (await exists(finalDirectory)) throw new Error("attempt receipt directory already exists");
  const staging = path.join(receiptsRoot, `.tmp-${randomBytes(12).toString("hex")}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await Promise.all([
      writeFile(path.join(staging, "condition.json"), `${canonicalJson(options.conditionRecord)}\n`, { mode: 0o600 }),
      writeFile(path.join(staging, "protocol.json"), `${canonicalJson(options.protocolReceipt)}\n`, { mode: 0o600 }),
      writeFile(path.join(staging, "run.json"), serializeRunReceipt(options.runReceipt), { mode: 0o600 }),
      ...(options.evaluatorReceipt
        ? [writeFile(path.join(staging, "evaluator.json"), `${canonicalJson(options.evaluatorReceipt)}\n`, { mode: 0o600 })]
        : []),
    ]);
    await rename(staging, finalDirectory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const rawText = serializeRawExperimentResultsJsonl(options.nextRaw, options.nextManifest, options.nextSources);
  await writeAtomicFile(path.join(options.root, EXPERIMENT_MANIFEST_FILE), `${canonicalJson(options.nextManifest)}\n`);
  await writeAtomicFile(path.join(options.root, EXPERIMENT_RAW_RESULTS_FILE), rawText);
}

async function loadExperimentState(root: string): Promise<LoadedExperimentState> {
  const rootInfo = await lstat(root).catch((cause) => {
    throw new Error("experiment root is missing or unreadable", { cause });
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("experiment root must be a non-symlink directory");
  const intentsRoot = path.join(root, EXPERIMENT_INTENTS_DIR);
  const intentsInfo = await lstat(intentsRoot).catch((cause) => {
    throw new Error("experiment intent directory is missing or unreadable", { cause });
  });
  if (intentsInfo.isSymbolicLink() || !intentsInfo.isDirectory()) {
    throw new Error("experiment intent directory must be a non-symlink directory");
  }
  const intents = await readdir(intentsRoot);
  if (intents.length > 0) {
    throw new Error(`experiment storage contains an incomplete attempt intent: ${intents.sort().join(", ")}`);
  }
  const manifestText = await readBoundedFile(path.join(root, EXPERIMENT_MANIFEST_FILE), MAX_STATE_FILE_BYTES, "experiment manifest");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText.toString("utf8"));
  } catch (cause) {
    throw new Error("stored experiment manifest is not valid JSON", { cause });
  }
  const manifest = parseExperimentManifest(manifestValue);
  const receiptsRoot = path.join(root, EXPERIMENT_RECEIPTS_DIR);
  const receiptsInfo = await lstat(receiptsRoot).catch((cause) => {
    throw new Error("experiment receipt directory is missing or unreadable", { cause });
  });
  if (receiptsInfo.isSymbolicLink() || !receiptsInfo.isDirectory()) {
    throw new Error("experiment receipt directory must be a non-symlink directory");
  }
  const receiptEntries = await readdir(receiptsRoot, { withFileTypes: true }).catch((cause) => {
    throw new Error("experiment receipt directory is missing or unreadable", { cause });
  });
  const expectedDirectories = new Set(manifest.attempts.map((attempt) => attemptReceiptDirectory(attempt.attempt_id)));
  for (const entry of receiptEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !expectedDirectories.has(entry.name)) {
      throw new Error(`experiment storage contains an orphan or unsafe receipt entry: ${entry.name}`);
    }
  }
  if (receiptEntries.length !== expectedDirectories.size) {
    throw new Error("experiment storage is missing an attempt receipt directory");
  }

  const receiptSources: EvaluatorReceiptSource[] = [];
  for (const attempt of manifest.attempts) {
    const relativeDirectory = path.posix.join(EXPERIMENT_RECEIPTS_DIR, attemptReceiptDirectory(attempt.attempt_id));
    const directory = path.join(root, relativeDirectory);
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error(`attempt ${JSON.stringify(attempt.attempt_id)} receipt path is not a safe directory`);
    }
    const names = (await readdir(directory)).sort();
    const expectedNames = attempt.evaluator_receipt_sha256
      ? ["condition.json", "evaluator.json", "protocol.json", "run.json"]
      : ["condition.json", "protocol.json", "run.json"];
    if (canonicalJson(names) !== canonicalJson(expectedNames)) {
      throw new Error(`attempt ${JSON.stringify(attempt.attempt_id)} has an incomplete or unexpected receipt set`);
    }
    const condition = parseExperimentConditionRecord(await readJsonFile(path.join(directory, "condition.json"), "condition receipt"));
    if (condition.condition_contract_sha256 !== attempt.condition_contract_sha256) {
      throw new Error(`attempt ${JSON.stringify(attempt.attempt_id)} condition receipt hash mismatch`);
    }
    const cell = requireCell(manifest, attempt.cell_id);
    const sample = requireSample(manifest, attempt.task_id, attempt.sample_id);
    if (
      condition.binding.plan_sha256 !== manifest.plan_sha256 ||
      condition.binding.attempt_id !== attempt.attempt_id ||
      condition.binding.cell_id !== attempt.cell_id ||
      condition.condition !== cell.condition ||
      condition.common.effective_config_sha256 !== manifest.plan.execution.config_sha256 ||
      condition.common.protocol_sha256 !== cell.protocol_sha256 ||
      condition.policy_version !== manifest.plan.execution.condition_policy_version ||
      condition.a0.workspace_tree_oid !== sample.a0.workspace_tree_oid ||
      condition.a0.tree_oid !== sample.a0.artifact_tree_oid ||
      condition.a0.subdir !== manifest.plan.execution.artifact_dir ||
      canonicalJson(condition.common.harness) !== canonicalJson(manifest.plan.execution.harness) ||
      Object.values(condition.common.models).some((model) => model !== manifest.plan.execution.resolved_model)
    ) {
      throw new Error(`attempt ${JSON.stringify(attempt.attempt_id)} condition receipt binding mismatch`);
    }
    const protocol = await readJsonFile(path.join(directory, "protocol.json"), "protocol receipt");
    assertProtocolReceiptIntegrity(protocol);
    if (
      protocol.protocol_sha256 !== attempt.protocol_receipt_sha256 ||
      protocol.config_sha256 !== manifest.plan.execution.config_sha256 ||
      canonicalJson(protocol.harness) !== canonicalJson(manifest.plan.execution.harness) ||
      commonResolvedModel(protocol) !== manifest.plan.execution.resolved_model
    ) {
      throw new Error(`attempt ${JSON.stringify(attempt.attempt_id)} protocol receipt hash mismatch`);
    }
    const run = parseRunReceipt(await readJsonFile(path.join(directory, "run.json"), "run receipt"));
    const runHarness = run.identities.harness as Record<string, unknown>;
    if (
      run.receipt_sha256 !== attempt.run_receipt_sha256 ||
      runHarness.protocol_sha256 !== attempt.protocol_receipt_sha256 ||
      runHarness.config_sha256 !== manifest.plan.execution.config_sha256 ||
      runHarness.name !== manifest.plan.execution.harness.name ||
      runHarness.version !== manifest.plan.execution.harness.version
    ) {
      throw new Error(`attempt ${JSON.stringify(attempt.attempt_id)} run receipt hash mismatch`);
    }
    if (attempt.evaluator_receipt_sha256) {
      const evaluator = (await readJsonFile(path.join(directory, "evaluator.json"), "evaluator receipt")) as EvaluatorReceipt;
      if (evaluatorReceiptSha256(evaluator) !== attempt.evaluator_receipt_sha256) {
        throw new Error(`attempt ${JSON.stringify(attempt.attempt_id)} evaluator receipt hash mismatch`);
      }
      receiptSources.push({ path: path.posix.join(relativeDirectory, "evaluator.json"), receipt: evaluator });
    }
  }
  const rawText = (await readBoundedFile(path.join(root, EXPERIMENT_RAW_RESULTS_FILE), MAX_STATE_FILE_BYTES, "raw result stream")).toString("utf8");
  const rawResults = parseRawExperimentResultsJsonl(rawText, manifest, receiptSources);
  const rawAttemptIds = new Set(rawResults.map((result) => result.attempt_id));
  const expectedRawAttemptIds = new Set(
    manifest.attempts.filter((attempt) => attempt.evaluator_receipt_sha256 !== null).map((attempt) => attempt.attempt_id),
  );
  if (
    rawAttemptIds.size !== expectedRawAttemptIds.size ||
    [...expectedRawAttemptIds].some((attemptId) => !rawAttemptIds.has(attemptId))
  ) {
    throw new Error("experiment storage has an inconsistent manifest/raw-result transaction");
  }
  await verifyStoredCompletion(root, manifest, rawResults, receiptSources);
  return { manifest, rawResults, receiptSources };
}

async function verifyStoredCompletion(
  root: string,
  manifest: ExperimentManifest,
  rawResults: readonly RawExperimentResult[],
  receiptSources: readonly EvaluatorReceiptSource[],
): Promise<void> {
  const aggregatePath = path.join(root, EXPERIMENT_AGGREGATE_FILE);
  const completePath = path.join(root, EXPERIMENT_COMPLETE_FILE);
  const [hasAggregate, hasComplete] = await Promise.all([exists(aggregatePath), exists(completePath)]);
  if (hasAggregate !== hasComplete) throw new Error("experiment storage has an incomplete aggregate/completion transaction");
  if (!hasAggregate) return;
  const expectedAggregate = serializeExperimentAggregateSummary(
    aggregateExperimentResults(manifest, rawResults, receiptSources),
  );
  const actualAggregate = (await readBoundedFile(aggregatePath, MAX_STATE_FILE_BYTES, "stored experiment aggregate")).toString("utf8");
  if (actualAggregate !== expectedAggregate) throw new Error("stored experiment aggregate does not match the verified raw results");
  const completion = await readJsonFile(completePath, "experiment completion receipt");
  const keys = Object.keys(completion).sort();
  const expectedKeys = [
    "aggregate_sha256",
    "attempt_count",
    "complete_sha256",
    "manifest_sha256",
    "plan_sha256",
    "raw_results_sha256",
    "schema_version",
  ];
  if (canonicalJson(keys) !== canonicalJson(expectedKeys)) throw new Error("experiment completion receipt is malformed");
  const { complete_sha256: completeSha256, ...payload } = completion;
  const rawText = serializeRawExperimentResultsJsonl(rawResults, manifest, receiptSources);
  if (
    completion.schema_version !== 1 ||
    completion.plan_sha256 !== manifest.plan_sha256 ||
    completion.manifest_sha256 !== canonicalSha256(manifest) ||
    completion.raw_results_sha256 !== sha256(Buffer.from(rawText, "utf8")) ||
    completion.aggregate_sha256 !== sha256(Buffer.from(actualAggregate, "utf8")) ||
    completion.attempt_count !== manifest.attempts.length ||
    completeSha256 !== canonicalSha256(payload)
  ) {
    throw new Error("experiment completion receipt does not bind the final manifest, raw results, and aggregate");
  }
}

async function createDeterministicArtifactArchive(workspace: string, treeOid: string, output: string): Promise<void> {
  if (!GIT_OID.test(treeOid)) throw new Error("candidate tree OID is not a full Git object id");
  const object = await sanitizedGit(["-C", workspace, "cat-file", "-t", treeOid], workspace, true);
  if (object.code !== 0 || object.stdout.trim() !== "tree") throw new Error("candidate tree is unavailable in the run repository");
  await assertNoArchiveTransformAttributes(workspace, treeOid);
  const isolated = await mkdtemp(path.join(os.tmpdir(), "hoh-experiment-git-archive-"));
  try {
    const bare = path.join(isolated, "repository.git");
    const format = (await sanitizedGit(["-C", workspace, "rev-parse", "--show-object-format"], workspace)).stdout.trim();
    if (format !== "sha1" && format !== "sha256") throw new Error(`unsupported Git object format ${JSON.stringify(format)}`);
    await sanitizedGit(["init", "--bare", `--object-format=${format}`, "-q", bare], workspace);
    const objects = await sanitizedGit(
      ["-C", workspace, "rev-parse", "--path-format=absolute", "--git-path", "objects"],
      workspace,
    );
    const objectDirectory = await realpath(objects.stdout.trim());
    const alternates = path.join(bare, "objects", "info", "alternates");
    await mkdir(path.dirname(alternates), { recursive: true });
    await writeFile(alternates, `${objectDirectory}\n`, { mode: 0o600 });
    await sanitizedGit(
      [
        `--git-dir=${bare}`,
        "archive",
        "--format=tar",
        "--prefix=artifact/",
        `--mtime=${ARCHIVE_MTIME}`,
        `--output=${output}`,
        treeOid,
      ],
      workspace,
    );
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
  const info = await stat(output);
  if (!info.isFile() || info.size < 1) throw new Error("git archive did not produce a regular artifact file");
  if (info.size > EVALUATOR_LIMITS.artifact_bytes) {
    throw new Error(`deterministic artifact archive exceeds evaluator limit ${EVALUATOR_LIMITS.artifact_bytes} bytes`);
  }
}

async function assertNoArchiveTransformAttributes(workspace: string, treeOid: string): Promise<void> {
  const listed = await sanitizedGit(["-C", workspace, "ls-tree", "-rz", "--name-only", treeOid], workspace);
  const attributeFiles = listed.stdout
    .split("\0")
    .filter((name) => name === ".gitattributes" || name.endsWith("/.gitattributes"));
  for (const filename of attributeFiles) {
    const shown = await sanitizedGit(["-C", workspace, "show", `${treeOid}:${filename}`], workspace);
    if (/\bexport-(?:ignore|subst)\b/.test(shown.stdout)) {
      throw new Error(`candidate ${filename} uses a Git archive transform and cannot be packaged as an exact experiment artifact`);
    }
  }
}

async function assertEvaluatorDidNotMutateWorkspace(
  workspace: string,
  expectedHead: string | null,
  expectedTree: string,
  expectedReceiptSha256: string,
): Promise<void> {
  const [head, tree, receipt] = await Promise.all([
    headCommit(workspace),
    artifactTreeHash(workspace, { subdir: "." }),
    verifyCurrentRunReceipt(workspace),
  ]);
  if (head !== expectedHead || tree !== expectedTree) {
    throw new Error("external evaluator mutated the completed development workspace");
  }
  if (!receipt.ok || receipt.receipt?.receipt_sha256 !== expectedReceiptSha256) {
    throw new Error("external evaluator changed the completed run receipt boundary");
  }
}

function assertEvaluatorReceiptInput(
  receipt: EvaluatorReceipt,
  sample: ExperimentManifest["plan"]["samples"][number],
  archive: { readonly bytes: number; readonly sha256: string },
): void {
  if (
    receipt.input.artifact_bytes !== archive.bytes ||
    receipt.input.artifact_sha256 !== archive.sha256 ||
    receipt.input.task_sha256 !== sample.evaluator_task_sha256 ||
    receipt.input.sample_sha256 !== sample.evaluator_sample_sha256
  ) {
    throw new Error("external evaluator receipt input does not match the pre-registered sample and exact candidate archive");
  }
}

async function assertEvaluatorExecutableIdentity(evaluator: BlindEvaluatorDefinition): Promise<void> {
  if (!evaluator || !Array.isArray(evaluator.argv) || evaluator.argv.length === 0 || !path.isAbsolute(evaluator.argv[0])) {
    throw new Error("pre-registered evaluator must use an absolute executable argv[0]");
  }
  const handle = await open(evaluator.argv[0], fsConstants.O_RDONLY).catch((cause) => {
    throw new Error("pre-registered evaluator executable is unreadable", { cause });
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("pre-registered evaluator executable must be a regular file");
    if (info.size > EVALUATOR_LIMITS.executable_bytes) throw new Error("pre-registered evaluator executable exceeds the hashing limit");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < info.size) {
      const next = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
      if (next.bytesRead === 0) break;
      hash.update(buffer.subarray(0, next.bytesRead));
      position += next.bytesRead;
    }
    if (position !== info.size || (await handle.read(buffer, 0, 1, position)).bytesRead !== 0) {
      throw new Error("pre-registered evaluator executable changed while hashing");
    }
    const actual = hash.digest("hex");
    if (actual !== evaluator.executable_sha256) {
      throw new Error(`pre-registered evaluator executable hash mismatch (${evaluator.executable_sha256} != ${actual})`);
    }
  } finally {
    await handle.close();
  }
}

async function prepareEmptyExperimentRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("experiment root must be a real directory");
  const entries = await readdir(root);
  if (entries.length > 0) throw new Error("experiment registration requires an empty experiment root");
}

async function createAttemptIntent(
  root: string,
  manifest: ExperimentManifest,
  request: RunExperimentAttemptRequest,
  cell: ExperimentCell,
): Promise<string> {
  const payload = {
    schema_version: 1 as const,
    plan_sha256: manifest.plan_sha256,
    attempt_id: request.attempt_id,
    cell_id: cell.id,
    condition: cell.condition,
    task_id: request.task_id,
    sample_id: request.sample_id,
    repetition: request.repetition,
    retry: request.retry ?? { attempt: 1, retry_of: null },
    created_at: new Date().toISOString(),
  };
  const intent = { ...payload, intent_sha256: canonicalSha256(payload) };
  const filename = path.join(root, EXPERIMENT_INTENTS_DIR, `${attemptReceiptDirectory(request.attempt_id)}.json`);
  await writeExclusiveFile(filename, `${canonicalJson(intent)}\n`);
  return filename;
}

async function completeAttemptIntent(filename: string): Promise<void> {
  await rm(filename);
}

async function withExperimentLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const lockPath = path.join(root, EXPERIMENT_LOCK_FILE);
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (cause: any) {
    if (cause?.code === "EEXIST") throw new Error("another experiment orchestration operation is already active");
    throw cause;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
    return await work();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function withGlobalExperimentExecutionGuard<T>(work: () => Promise<T>): Promise<T> {
  if (experimentExecutionActive) {
    throw new Error("another experiment condition is active in this process; condition runs must be sequential");
  }
  experimentExecutionActive = true;
  const environment = Object.fromEntries(EXPERIMENT_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof EXPERIMENT_ENV_KEYS)[number],
    string | undefined
  >;
  try {
    return await work();
  } finally {
    for (const key of EXPERIMENT_ENV_KEYS) {
      const value = environment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    experimentExecutionActive = false;
  }
}

async function assertDisjointPaths(left: string, right: string, leftName: string, rightName: string): Promise<void> {
  const [canonicalLeft, canonicalRight] = await Promise.all([canonicalExistingPath(left), canonicalExistingPath(right)]);
  if (containsPath(canonicalLeft, canonicalRight) || containsPath(canonicalRight, canonicalLeft)) {
    throw new Error(`${leftName} and ${rightName} must be disjoint directories`);
  }
}

async function canonicalExistingPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertAttemptCoordinateAvailable(manifest: ExperimentManifest, request: RunExperimentAttemptRequest): void {
  if (manifest.attempts.some((attempt) => attempt.attempt_id === request.attempt_id)) {
    throw new Error(`attempt id is already present in the manifest: ${JSON.stringify(request.attempt_id)}`);
  }
  const retry = request.retry ?? { attempt: 1, retry_of: null };
  const probe: ExperimentAttemptOutcome = {
    plan_sha256: manifest.plan_sha256,
    attempt_id: request.attempt_id,
    cell_id: request.cell_id,
    task_id: request.task_id,
    sample_id: request.sample_id,
    repetition: request.repetition,
    retry,
    condition_contract_sha256: "0".repeat(64),
    protocol_receipt_sha256: requireCell(manifest, request.cell_id).protocol_sha256,
    run_receipt_sha256: "0".repeat(64),
    evaluator_receipt_sha256: "0".repeat(64),
    status: "completed",
    failure: null,
    valid: true,
    invalid_reason: null,
  };
  addExperimentAttempt(manifest, probe);
}

function requireCell(manifest: ExperimentManifest, cellId: string): ExperimentCell {
  const cell = manifest.plan.cells.find((candidate) => candidate.id === cellId);
  if (!cell) throw new Error(`cell id is not in the pre-registered manifest: ${JSON.stringify(cellId)}`);
  return cell;
}

function requireSample(manifest: ExperimentManifest, taskId: string, sampleId: string): ExperimentManifest["plan"]["samples"][number] {
  const sample = manifest.plan.samples.find((candidate) => candidate.task_id === taskId && candidate.sample_id === sampleId);
  if (!sample) throw new Error(`task/sample is not in the pre-registered manifest: ${JSON.stringify(`${taskId}/${sampleId}`)}`);
  return sample;
}

function evaluatorPrivateValues(
  manifest: ExperimentManifest,
  request: RunExperimentAttemptRequest,
  cell: ExperimentCell,
  result: ExperimentConditionResult,
  root: string,
  workspace: string,
): readonly string[] {
  return [
    manifest.plan_sha256,
    request.attempt_id,
    cell.id,
    cell.condition,
    result.condition_contract_sha256,
    result.run_receipt_sha256,
    root,
    workspace,
  ];
}

function attemptReceiptDirectory(attemptId: string): string {
  return createHash("sha256").update(`attempt\0${attemptId}`, "utf8").digest("hex");
}

function evaluatorReceiptRelativePath(attemptId: string): string {
  return path.posix.join(EXPERIMENT_RECEIPTS_DIR, attemptReceiptDirectory(attemptId), "evaluator.json");
}

function assignmentKey(manifest: ExperimentManifest, assignment: ExperimentAssignment): string {
  return canonicalSha256({ seed: manifest.plan.assignment_seed, plan_sha256: manifest.plan_sha256, coordinate: assignment });
}

function coordinateKey(value: ExperimentAssignment): string {
  return `${value.cell_id}\0${value.task_id}\0${value.sample_id}\0${value.repetition}`;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedUtf8(value: string, limit: number, at: string): Buffer {
  if (typeof value !== "string") throw new Error(`${at} must be a string`);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > limit) throw new Error(`${at} exceeds ${limit} UTF-8 bytes`);
  return bytes;
}

async function readBoundedFile(filename: string, limit: number, at: string): Promise<Buffer> {
  const before = await lstat(filename).catch((cause) => {
    throw new Error(`${at} is missing or unreadable`, { cause });
  });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${at} must be a non-symlink regular file`);
  if (before.size > limit) throw new Error(`${at} exceeds ${limit} bytes`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filename, fsConstants.O_RDONLY | noFollow).catch((cause) => {
    throw new Error(`${at} became unreadable`, { cause });
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`${at} changed before it was opened`);
    }
    const value = await handle.readFile();
    const after = await handle.stat();
    if (
      value.byteLength !== before.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${at} changed while being read`);
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function readJsonFile(filename: string, at: string): Promise<any> {
  const text = (await readBoundedFile(filename, MAX_STATE_FILE_BYTES, at)).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`${at} is not valid JSON`, { cause });
  }
}

async function writeExclusiveFile(filename: string, value: string): Promise<void> {
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicFile(filename: string, value: string): Promise<void> {
  const temporary = `${filename}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function sanitizedGit(
  args: readonly string[],
  cwd: string,
  allowFail = false,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? -1, stdout, stderr };
      if (result.code !== 0 && !allowFail) {
        reject(new Error(`sanitized git ${args.join(" ")} failed (${result.code}): ${stderr.trim() || stdout.trim()}`));
      } else {
        resolve(result);
      }
    });
  });
}

async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
