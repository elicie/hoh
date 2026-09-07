/** Execute the five pre-registered development conditions without invoking an evaluator. */
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Harness } from "../harness/types.js";
import { CODING_TOOLS } from "../harness/types.js";
import type { BudgetLedger, DeveloperRecord, Ledger, ProtocolReceipt, Role, RunConfig } from "../types.js";
import { invokeRole, installCapturedTranscript } from "../runtime/role.js";
import { BudgetExhaustedError, BudgetTracker } from "../runtime/budget.js";
import { assertValidConfig, type ConfigPatch, DEFAULT_CONFIG, type HohConfig, mergeConfig, modelForRole } from "../runtime/config.js";
import {
  artifactTreeHash,
  changedPaths,
  commitAll,
  ensureRepo,
  git,
  headCommit,
  pathsChanged,
  restorePaths,
  ROLE_IDENTITY,
  RUNTIME_IDENTITY,
} from "../runtime/git.js";
import { emptyLedger } from "../runtime/ledger.js";
import { parseClaimCatalog } from "../runtime/coverage.js";
import {
  type ExperimentA0Identity,
  type HohExperimentCondition,
  type Logger,
  runHoh,
} from "../runtime/loop.js";
import { buildPromptSnapshot, promptSha256 } from "../runtime/prompt-snapshot.js";
import { assertRolePromptWithinLimit, render, renderContextDisclosure } from "../runtime/prompts.js";
import { buildProtocolReceipt, canonicalSha256 } from "../runtime/protocol.js";
import { configuredProviderSecretValues } from "../runtime/redaction.js";
import { assertSafeRunRecordLayout, refreshRunReceipt, verifyCurrentRunReceipt } from "../runtime/run-receipt.js";
import type { RunReceipt } from "../runtime/receipt.js";
import { readJson, RunPaths, writeJson } from "../runtime/state.js";
import { EXPERIMENT_CONDITIONS, type ExperimentCondition } from "./manifest.js";

export const EXPERIMENT_CONDITION_POLICY_VERSION = "arxiv:2609.01481v1/conditions-v1" as const;
export const EXPERIMENT_CONDITION_RECORD = ".hoh/experiment-condition.json";

export interface ExperimentConditionBinding {
  readonly plan_sha256: string;
  readonly attempt_id: string;
  readonly cell_id: string;
}

export interface ExperimentConditionRequest {
  readonly condition: ExperimentCondition;
  readonly workspace: string;
  readonly specPath: string;
  readonly harness: Harness;
  readonly config: ConfigPatch;
  readonly binding: ExperimentConditionBinding;
  readonly signal?: AbortSignal;
  readonly log?: Logger;
}

export interface ExperimentConditionPolicy {
  readonly planner: "every-loop-with-feedback" | "loop-1-fixed" | "every-loop-spec-and-artifact-only" | "absent";
  readonly developer_base: "previous-candidate" | "fixed-a0";
  readonly qa: "every-loop" | "absent";
}

export interface ExperimentConditionRecord {
  readonly schema_version: 1;
  readonly condition: ExperimentCondition;
  readonly policy_version: typeof EXPERIMENT_CONDITION_POLICY_VERSION;
  readonly binding: ExperimentConditionBinding;
  readonly a0: ExperimentA0Identity;
  readonly common: {
    readonly effective_config_sha256: string;
    readonly protocol_sha256: string;
    readonly models: ProtocolReceipt["models"];
    readonly harness: ProtocolReceipt["harness"];
  };
  readonly policy: ExperimentConditionPolicy;
  readonly condition_contract_sha256: string;
}

export interface ExperimentConditionResult {
  readonly condition: ExperimentCondition;
  readonly binding: ExperimentConditionBinding;
  readonly condition_contract_sha256: string;
  readonly run_receipt_sha256: string;
  /** The fully verified final receipt, including its historical candidate binding. */
  readonly run_receipt: RunReceipt;
  readonly protocol_receipt_sha256: string | null;
  readonly final_artifact: ExperimentFinalArtifactIdentity;
  readonly status: "completed" | "budget_exhausted";
}

export interface ExperimentFinalArtifactIdentity {
  readonly commit_oid: string;
  readonly tree_oid: string;
  readonly subdir: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const VANILLA_DEVELOPER_SYSTEM_PROMPT = [
  "You are the sole Developer in a continuous development run.",
  "Improve the current artifact against the public specification.",
  "You may inspect, execute, and edit product files, but must not modify .hoh runtime records.",
  "Do not assume requirements beyond the public specification.",
].join("\n");
const VANILLA_DEVELOPER_USER_TEMPLATE = [
  "# Continuous development iteration {{loop_index}}",
  "",
  "Workspace: `{{cwd}}`",
  "Artifact directory: `{{artifact_dir}}`",
  "Current artifact identity: `{{base_candidate_id}}`",
  "",
  "## Public specification",
  "",
  "{{specification}}",
  "",
  "Continue improving the latest artifact, preserve working behavior, and summarize the changes when finished.",
].join("\n");

/** Strictly validate a persisted condition contract and its canonical hash. */
export function parseExperimentConditionRecord(value: unknown): ExperimentConditionRecord {
  const raw = object(value, "experiment condition record");
  exactKeys(
    raw,
    ["schema_version", "condition", "policy_version", "binding", "a0", "common", "policy", "condition_contract_sha256"],
    "experiment condition record",
  );
  if (raw.schema_version !== 1) throw new Error("experiment condition record.schema_version must be 1");
  if (typeof raw.condition !== "string" || !EXPERIMENT_CONDITIONS.includes(raw.condition as ExperimentCondition)) {
    throw new Error(`experiment condition record.condition must be one of ${EXPERIMENT_CONDITIONS.join(", ")}`);
  }
  if (raw.policy_version !== EXPERIMENT_CONDITION_POLICY_VERSION) {
    throw new Error(`experiment condition record.policy_version must be ${EXPERIMENT_CONDITION_POLICY_VERSION}`);
  }
  const condition = raw.condition as ExperimentCondition;
  const binding = parseBinding(raw.binding, "experiment condition record.binding");
  const a0Raw = object(raw.a0, "experiment condition record.a0");
  exactKeys(a0Raw, ["commit_oid", "workspace_tree_oid", "tree_oid", "subdir"], "experiment condition record.a0");
  if (typeof a0Raw.commit_oid !== "string" || !GIT_OID.test(a0Raw.commit_oid)) {
    throw new Error("experiment condition record.a0.commit_oid must be a full lowercase Git object ID");
  }
  if (typeof a0Raw.tree_oid !== "string" || !GIT_OID.test(a0Raw.tree_oid)) {
    throw new Error("experiment condition record.a0.tree_oid must be a full lowercase Git object ID");
  }
  if (typeof a0Raw.workspace_tree_oid !== "string" || !GIT_OID.test(a0Raw.workspace_tree_oid)) {
    throw new Error("experiment condition record.a0.workspace_tree_oid must be a full lowercase Git object ID");
  }
  if (typeof a0Raw.subdir !== "string" || !isCanonicalArtifactSubdir(a0Raw.subdir)) {
    throw new Error("experiment condition record.a0.subdir must be a canonical product path outside .hoh");
  }
  const commonRaw = object(raw.common, "experiment condition record.common");
  exactKeys(commonRaw, ["effective_config_sha256", "protocol_sha256", "models", "harness"], "experiment condition record.common");
  if (typeof commonRaw.effective_config_sha256 !== "string" || !SHA256.test(commonRaw.effective_config_sha256)) {
    throw new Error("experiment condition record.common.effective_config_sha256 must be a lowercase SHA-256 digest");
  }
  if (typeof commonRaw.protocol_sha256 !== "string" || !SHA256.test(commonRaw.protocol_sha256)) {
    throw new Error("experiment condition record.common.protocol_sha256 must be a lowercase SHA-256 digest");
  }
  const modelsRaw = object(commonRaw.models, "experiment condition record.common.models");
  exactKeys(modelsRaw, ["planner", "developer", "tester"], "experiment condition record.common.models");
  const models = Object.fromEntries(
    (["planner", "developer", "tester"] as const).map((role) => {
      const model = modelsRaw[role];
      if (model !== null && (typeof model !== "string" || !model.trim())) {
        throw new Error(`experiment condition record.common.models.${role} must be null or a non-empty string`);
      }
      return [role, model];
    }),
  ) as Record<Role, string | null>;
  const harnessRaw = object(commonRaw.harness, "experiment condition record.common.harness");
  exactKeys(harnessRaw, ["name", "version"], "experiment condition record.common.harness");
  if (typeof harnessRaw.name !== "string" || !harnessRaw.name.trim() || typeof harnessRaw.version !== "string" || !harnessRaw.version.trim()) {
    throw new Error("experiment condition record.common.harness name/version must be non-empty strings");
  }
  const policyRaw = object(raw.policy, "experiment condition record.policy");
  exactKeys(policyRaw, ["planner", "developer_base", "qa"], "experiment condition record.policy");
  const expectedPolicy = conditionPolicy(condition);
  if (canonicalSha256(policyRaw) !== canonicalSha256(expectedPolicy)) {
    throw new Error(`experiment condition record.policy does not match condition ${condition}`);
  }
  if (typeof raw.condition_contract_sha256 !== "string" || !SHA256.test(raw.condition_contract_sha256)) {
    throw new Error("experiment condition record.condition_contract_sha256 must be a lowercase SHA-256 digest");
  }
  const parsed: ExperimentConditionRecord = {
    schema_version: 1,
    condition,
    policy_version: EXPERIMENT_CONDITION_POLICY_VERSION,
    binding,
    a0: {
      commit_oid: a0Raw.commit_oid,
      workspace_tree_oid: a0Raw.workspace_tree_oid,
      tree_oid: a0Raw.tree_oid,
      subdir: a0Raw.subdir,
    },
    common: {
      effective_config_sha256: commonRaw.effective_config_sha256,
      protocol_sha256: commonRaw.protocol_sha256,
      models,
      harness: { name: harnessRaw.name, version: harnessRaw.version },
    },
    policy: expectedPolicy,
    condition_contract_sha256: raw.condition_contract_sha256,
  };
  const actual = canonicalSha256(withoutConditionHash(parsed));
  if (actual !== parsed.condition_contract_sha256) {
    throw new Error(
      `experiment condition record failed its integrity check (${parsed.condition_contract_sha256.slice(0, 12)} != ${actual.slice(0, 12)})`,
    );
  }
  return deepFreeze(structuredClone(parsed));
}

/**
 * Run exactly one condition in a fresh run workspace. The API deliberately has
 * no evaluator input: scoring stays outside the development-role boundary.
 */
export async function runExperimentCondition(request: ExperimentConditionRequest): Promise<ExperimentConditionResult> {
  request.signal?.throwIfAborted();
  assertConditionRequest(request);
  const workspace = path.resolve(request.workspace);
  const specPath = path.resolve(request.specPath);
  const log = request.log ?? (() => {});
  await mkdir(workspace, { recursive: true });
  const paths = new RunPaths(workspace);
  await ensureRepo(workspace);
  await assertSafeRunRecordLayout(paths);
  await assertFreshExperimentRuntime(paths, specPath);
  if ((await fileExists(paths.runJson)) || (await fileExists(path.join(workspace, EXPERIMENT_CONDITION_RECORD)))) {
    throw new Error("experiment conditions require a fresh run workspace without an existing run or condition record");
  }

  const config = mergeConfig(DEFAULT_CONFIG, request.config);
  assertValidConfig(config, "experiment condition request");
  if (request.harness.name !== config.harness) {
    throw new Error(`configured harness is "${config.harness}" but a "${request.harness.name}" harness was supplied`);
  }

  const a0 = await freezeA0(workspace, config.artifact_dir);
  const protocolReceipt = await buildExperimentProtocolReceipt(config, request.harness, request.condition);
  const record = createConditionRecord(request.condition, request.binding, a0, config, protocolReceipt);
  await writeJson(path.join(workspace, EXPERIMENT_CONDITION_RECORD), record);

  let status: ExperimentConditionResult["status"];
  let run: RunConfig;
  if (request.condition === "vanilla") {
    const result = await runVanillaCondition({
      workspace,
      specPath,
      harness: request.harness,
      config,
      protocolReceipt,
      signal: request.signal,
      log,
    });
    status = result.status;
    run = result.run;
  } else {
    const result = await runHoh({
      workspace,
      specPath,
      harness: request.harness,
      config,
      configSource: `experiment condition ${request.condition}`,
      signal: request.signal,
      log,
      experimentPolicy: {
        condition: request.condition as HohExperimentCondition,
        a0,
        protocolReceipt,
      },
    });
    status = result.status;
    run = result.run;
  }

  const storedRecordValue = await readJson<unknown>(path.join(workspace, EXPERIMENT_CONDITION_RECORD));
  const storedRecord = storedRecordValue === null ? null : parseExperimentConditionRecord(storedRecordValue);
  if (!storedRecord || storedRecord.condition_contract_sha256 !== record.condition_contract_sha256) {
    throw new Error("experiment condition contract changed during execution");
  }
  if (run.protocol_receipt?.protocol_sha256 !== storedRecord.common.protocol_sha256) {
    throw new Error("experiment protocol receipt differs from the pre-registered condition contract");
  }
  const verification = await verifyCurrentRunReceipt(workspace);
  if (!verification.ok || !verification.receipt) {
    throw new Error(`experiment run receipt verification failed: ${verification.issues.map((issue) => issue.code).join(", ") || "missing receipt"}`);
  }
  const finalArtifact = verification.receipt.candidate ?? a0;
  return {
    condition: request.condition,
    binding: structuredClone(request.binding),
    condition_contract_sha256: record.condition_contract_sha256,
    run_receipt_sha256: verification.receipt.receipt_sha256,
    run_receipt: verification.receipt,
    protocol_receipt_sha256: run.protocol_receipt?.protocol_sha256 ?? null,
    final_artifact: {
      commit_oid: finalArtifact.commit_oid,
      tree_oid: finalArtifact.tree_oid,
      subdir: finalArtifact.subdir,
    },
    status,
  };
}

function createConditionRecord(
  condition: ExperimentCondition,
  binding: ExperimentConditionBinding,
  a0: ExperimentA0Identity,
  config: HohConfig,
  protocolReceipt: ProtocolReceipt,
): ExperimentConditionRecord {
  const payload = {
    schema_version: 1 as const,
    condition,
    policy_version: EXPERIMENT_CONDITION_POLICY_VERSION,
    binding: structuredClone(binding),
    a0: structuredClone(a0),
    common: {
      effective_config_sha256: canonicalSha256(config),
      protocol_sha256: protocolReceipt.protocol_sha256,
      models: structuredClone(protocolReceipt.models),
      harness: structuredClone(protocolReceipt.harness),
    },
    policy: conditionPolicy(condition),
  };
  return { ...payload, condition_contract_sha256: canonicalSha256(payload) };
}

function conditionPolicy(condition: ExperimentCondition): ExperimentConditionPolicy {
  switch (condition) {
    case "hoh":
      return { planner: "every-loop-with-feedback", developer_base: "previous-candidate", qa: "every-loop" };
    case "vanilla":
      return { planner: "absent", developer_base: "previous-candidate", qa: "absent" };
    case "no-plan-update":
      return { planner: "loop-1-fixed", developer_base: "previous-candidate", qa: "every-loop" };
    case "no-evidence":
      return { planner: "every-loop-spec-and-artifact-only", developer_base: "previous-candidate", qa: "every-loop" };
    case "no-warm-start":
      return { planner: "every-loop-with-feedback", developer_base: "fixed-a0", qa: "every-loop" };
  }
}

/** Resolve the exact protocol receipt that must be pre-registered for one condition. */
export async function buildExperimentProtocolReceipt(
  config: HohConfig,
  harness: Harness,
  condition: ExperimentCondition,
): Promise<ProtocolReceipt> {
  if (!EXPERIMENT_CONDITIONS.includes(condition)) {
    throw new Error(`condition must be one of ${EXPERIMENT_CONDITIONS.join(", ")}`);
  }
  assertValidConfig(config, "experiment protocol receipt");
  if (harness.name !== config.harness) {
    throw new Error(`configured harness is "${config.harness}" but a "${harness.name}" harness was supplied`);
  }
  const receipt = await buildProtocolReceipt(config, harness, { legacyDefault: false, origin: "run_start" });
  if (condition !== "vanilla") return receipt;
  const { protocol_sha256: _priorHash, ...base } = receipt;
  const payload = {
    ...base,
    role_contracts: {
      ...base.role_contracts,
      developer: {
        ...base.role_contracts.developer,
        system_prompt_sha256: promptSha256(VANILLA_DEVELOPER_SYSTEM_PROMPT),
        user_prompt_sha256: promptSha256(VANILLA_DEVELOPER_USER_TEMPLATE),
      },
    },
  };
  return { ...payload, protocol_sha256: canonicalSha256(payload) };
}

function withoutConditionHash(record: ExperimentConditionRecord): Omit<ExperimentConditionRecord, "condition_contract_sha256"> {
  const { condition_contract_sha256: _hash, ...payload } = record;
  return payload;
}

async function freezeA0(workspace: string, artifactDir: string): Promise<ExperimentA0Identity> {
  // Rebuild the index so A0 fixes the whole product workspace while excluding
  // runtime-owned records, regardless of the caller's ambient staging state.
  await git(["reset", "-q", "HEAD", "--", "."], workspace, { allowFail: true });
  const committed = await commitAll(workspace, "chore(experiment): freeze A0 product tree", RUNTIME_IDENTITY, [
    ".",
    ":(exclude).hoh",
  ]);
  let commitOid = committed ?? (await headCommit(workspace));
  if (!commitOid) {
    await git(["commit", "-q", "--allow-empty", "--no-verify", "-m", "chore(experiment): freeze empty A0 product tree"], workspace, {
      env: {
        GIT_AUTHOR_NAME: RUNTIME_IDENTITY.name,
        GIT_AUTHOR_EMAIL: RUNTIME_IDENTITY.email,
        GIT_COMMITTER_NAME: RUNTIME_IDENTITY.name,
        GIT_COMMITTER_EMAIL: RUNTIME_IDENTITY.email,
      },
    });
    commitOid = await headCommit(workspace);
  }
  if (!commitOid || !GIT_OID.test(commitOid)) throw new Error("could not create a full Git commit identity for experiment A0");
  return {
    commit_oid: commitOid,
    workspace_tree_oid: await artifactTreeHash(workspace, { subdir: "." }),
    tree_oid: await artifactTreeHash(workspace, { subdir: artifactDir }),
    subdir: artifactDir,
  };
}

async function assertFreshExperimentRuntime(paths: RunPaths, specPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(paths.root);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const stale = entries.filter((name) => name !== path.basename(paths.claims));
  if (stale.length > 0) {
    throw new Error(`experiment conditions require a fresh .hoh runtime root; found stale entries: ${stale.sort().join(", ")}`);
  }
  if (!entries.includes(path.basename(paths.claims))) return;
  const [rawClaims, spec] = await Promise.all([readJson<unknown>(paths.claims), readFile(specPath, "utf8")]);
  if (rawClaims === null) throw new Error("pre-existing .hoh/claims.json must be a regular JSON file");
  parseClaimCatalog(rawClaims, spec);
}

interface VanillaRunInput {
  workspace: string;
  specPath: string;
  harness: Harness;
  config: HohConfig;
  protocolReceipt: ProtocolReceipt;
  signal?: AbortSignal;
  log: Logger;
}

async function runVanillaCondition(
  input: VanillaRunInput,
): Promise<{ run: RunConfig; status: "completed" | "budget_exhausted"; budget: BudgetLedger; ledger: Ledger }> {
  const { workspace, config, protocolReceipt, harness, signal, log } = input;
  signal?.throwIfAborted();
  const paths = new RunPaths(workspace);
  await mkdir(paths.root, { recursive: true });
  await copyFile(input.specPath, paths.spec);
  const run: RunConfig = {
    schema_version: 1,
    run_id: `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`,
    spec_path: paths.rel(paths.spec),
    created_at: new Date().toISOString(),
    config,
    config_source: "experiment condition vanilla",
    protocol_receipt: protocolReceipt,
  };
  await writeJson(paths.config, config);
  await writeJson(paths.runJson, run);
  if (harness.resourceManifest) await writeJson(paths.piResources, harness.resourceManifest);
  const ledger = emptyLedger();
  await writeJson(paths.ledger, ledger);
  const budget = await BudgetTracker.open(paths, config.budgets);
  await checkpointVanilla(paths, run);
  await commitAll(workspace, `chore(hoh): initialize run ${run.run_id}`, RUNTIME_IDENTITY, ["."]);

  process.env.HOH_WORKSPACE = workspace;
  process.env.HOH_RUN_ID = run.run_id;
  let currentLoop = 0;
  try {
    for (let loopIndex = 1; loopIndex <= config.loops; loopIndex += 1) {
      currentLoop = loopIndex;
      signal?.throwIfAborted();
      await budget.startLoop(loopIndex);
      await runVanillaDeveloper({ ...input, paths, run, budget, loopIndex });
      await budget.endLoop(loopIndex);
      await checkpointVanilla(paths, run);
      await commitAll(workspace, `chore(loop-${String(loopIndex).padStart(2, "0")}): checkpoint vanilla run`, RUNTIME_IDENTITY, [
        paths.rel(paths.budget),
        paths.rel(paths.receipt),
      ]);
    }
  } catch (error) {
    if (currentLoop > 0) await budget.pauseLoop(currentLoop);
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof BudgetExhaustedError) {
      const budgetLedger = await budget.finish(false);
      await checkpointVanilla(paths, run);
      await commitAll(workspace, "chore(hoh): checkpoint exhausted vanilla run", RUNTIME_IDENTITY, [".hoh"]);
      return { run, status: "budget_exhausted", budget: budgetLedger, ledger };
    }
    const loopIndex = Math.max(1, currentLoop);
    await writeJson(paths.errorJson(loopIndex), {
      loop_index: loopIndex,
      role: "developer",
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    });
    await checkpointVanilla(paths, run);
    await commitAll(workspace, `chore(loop-${String(loopIndex).padStart(2, "0")}): vanilla runtime error`, RUNTIME_IDENTITY, [".hoh"]);
    throw error;
  }
  const budgetLedger = await budget.finish(true);
  await checkpointVanilla(paths, run);
  await commitAll(workspace, "chore(hoh): finalize vanilla run accounting", RUNTIME_IDENTITY, [
    paths.rel(paths.budget),
    paths.rel(paths.receipt),
  ]);
  log(`vanilla: completed ${config.loops} Developer-only loop(s)`);
  return {
    run,
    status: budgetLedger.status === "budget_exhausted" ? "budget_exhausted" : "completed",
    budget: budgetLedger,
    ledger,
  };
}

interface VanillaDeveloperInput extends VanillaRunInput {
  paths: RunPaths;
  run: RunConfig;
  budget: BudgetTracker;
  loopIndex: number;
}

async function runVanillaDeveloper(input: VanillaDeveloperInput): Promise<void> {
  const { workspace, config, harness, signal, paths, budget, loopIndex, log } = input;
  signal?.throwIfAborted();
  process.env.HOH_LOOP = String(loopIndex);
  process.env.HOH_ROLE = "developer";
  const loopDir = paths.loopDir(loopIndex);
  await mkdir(path.join(loopDir, "transcripts"), { recursive: true });
  const preDevelopmentCommit = await headCommit(workspace);
  if (!preDevelopmentCommit) throw new Error(`cannot start vanilla Developer loop ${loopIndex}: workspace has no base commit`);
  const treeBefore = await artifactTreeHash(workspace, { subdir: config.artifact_dir });
  const baseCandidateId = `loop-${String(loopIndex - 1).padStart(2, "0")}-${treeBefore.slice(0, 12)}`;
  const spec = await readFile(paths.spec, "utf8");
  const systemPrompt = VANILLA_DEVELOPER_SYSTEM_PROMPT;
  const userPrompt = render(VANILLA_DEVELOPER_USER_TEMPLATE, {
    loop_index: loopIndex,
    cwd: workspace,
    artifact_dir: config.artifact_dir,
    base_candidate_id: baseCandidateId,
    specification: renderContextDisclosure({
      sourcePath: paths.rel(paths.spec),
      content: spec,
      index: `- ${spec.split(/\r?\n/).length} lines; read the canonical specification when this view is omitted.`,
    }),
  });
  assertRolePromptWithinLimit("developer", systemPrompt, userPrompt);

  const runtimeDirtyBefore = new Set(await pathsChanged(workspace, [".hoh"], { includeIgnored: true }));
  let developerHeadMoved = false;
  let invocation: Awaited<ReturnType<typeof invokeRole>>;
  try {
    invocation = await invokeRole({
      ws: workspace, paths, run: input.run, harness, budget, log, signal,
      storageSecrets: configuredProviderSecretValues(config),
    }, {
      role: "developer", loopIndex, cwd: workspace, systemPrompt, prompt: userPrompt,
      tools: CODING_TOOLS, structuredTools: [],
      timeoutMs: config.timeouts.role_min * 60_000,
      model: modelForRole(config, "developer"), signal,
      transcriptPath: paths.transcript(loopIndex, "developer"),
    });
  } finally {
    developerHeadMoved = await reanchorVanillaHead(workspace, preDevelopmentCommit);
  }
  const { result, usage } = invocation;
  const unauthorized = (await pathsChanged(workspace, [".hoh"], { includeIgnored: true })).filter((changed) => {
    const relative = changed.replaceAll(path.sep, "/");
    return !runtimeDirtyBefore.has(changed) && relative !== paths.rel(paths.budget).replaceAll(path.sep, "/");
  });
  if (unauthorized.length) {
    await restorePaths(
      workspace,
      unauthorized.map((changed) => `:(literal)${changed}`),
      { includeIgnored: true },
    );
    log(`[loop ${String(loopIndex).padStart(2, "0")}] vanilla developer: reverted ${unauthorized.length} runtime-record change(s)`);
  }
  await budget.persist();
  const storageSecrets = configuredProviderSecretValues(config);
  await installCapturedTranscript(invocation.transcript, storageSecrets);
  await git(["reset", "-q", "HEAD", "--", ".hoh"], workspace, { allowFail: true });
  const commit = await commitAll(
    workspace,
    `feat(loop-${String(loopIndex).padStart(2, "0")}): continuous development`,
    ROLE_IDENTITY.developer,
    [".", ":(exclude).hoh"],
  );
  const candidateTree = await artifactTreeHash(workspace, { subdir: config.artifact_dir });
  const candidateCommit = commit ?? preDevelopmentCommit;
  const developer: DeveloperRecord = {
    schema_version: 1,
    loop_index: loopIndex,
    base_candidate_id: baseCandidateId,
    candidate_id: `loop-${String(loopIndex).padStart(2, "0")}-${candidateTree.slice(0, 12)}`,
    candidate_tree_sha: candidateTree,
    base_commit_sha: preDevelopmentCommit,
    candidate_commit_sha: candidateCommit,
    artifact_subdir: config.artifact_dir,
    commit,
    changed_paths: commit
      ? (await changedPaths(workspace, preDevelopmentCommit, commit)).filter((relative) => !relative.startsWith(".hoh/"))
      : [],
    summary: result.finalText,
    violations: [
      ...(developerHeadMoved ? ["moved Git HEAD during Developer invocation (re-anchored)"] : []),
      ...unauthorized.map((relative) => `modified runtime record ${relative} (reverted)`),
    ],
    usage,
    created_at: new Date().toISOString(),
  };
  await writeJson(paths.developerJson(loopIndex), developer);
  await writeJson(
    paths.promptSnapshot(loopIndex, "developer"),
    buildPromptSnapshot({
      role: "developer",
      loopIndex,
      finalAttempt: 1,
      systemPrompt: invocation.finalSystemPrompt,
      userPrompt: invocation.finalUserPrompt,
      explicitSecrets: storageSecrets,
    }),
  );
  await commitAll(workspace, `chore(loop-${String(loopIndex).padStart(2, "0")}): record vanilla Developer`, RUNTIME_IDENTITY, [".hoh"]);
}

async function checkpointVanilla(paths: RunPaths, run: RunConfig): Promise<RunReceipt> {
  await refreshRunReceipt(paths, run);
  const verification = await verifyCurrentRunReceipt(paths.workspace);
  if (!verification.ok || !verification.receipt) {
    throw new Error(`new vanilla run receipt failed verification: ${verification.issues.map((issue) => issue.code).join(", ")}`);
  }
  return verification.receipt;
}

function assertConditionRequest(request: ExperimentConditionRequest): void {
  if (!EXPERIMENT_CONDITIONS.includes(request.condition)) {
    throw new Error(`condition must be one of ${EXPERIMENT_CONDITIONS.join(", ")}`);
  }
  parseBinding(request.binding, "binding");
}

function parseBinding(value: unknown, at: string): ExperimentConditionBinding {
  const raw = object(value, at);
  exactKeys(raw, ["plan_sha256", "attempt_id", "cell_id"], at);
  if (typeof raw.plan_sha256 !== "string" || !SHA256.test(raw.plan_sha256)) {
    throw new Error(`${at}.plan_sha256 must be a lowercase SHA-256 digest`);
  }
  for (const key of ["attempt_id", "cell_id"] as const) {
    const field = raw[key];
    if (typeof field !== "string" || !field || field !== field.trim() || /[\0\r\n]/.test(field)) {
      throw new Error(`${at}.${key} must be a non-empty single-line identifier`);
    }
  }
  return { plan_sha256: raw.plan_sha256, attempt_id: raw.attempt_id as string, cell_id: raw.cell_id as string };
}

function isCanonicalArtifactSubdir(value: string): boolean {
  if (!value || path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /[\\\0\r\n]/.test(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return (
    normalized === value &&
    (value === "." || !value.endsWith("/")) &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    normalized !== ".hoh" &&
    !normalized.startsWith(".hoh/")
  );
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${at} must contain exactly: ${wanted.join(", ")}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

async function reanchorVanillaHead(workspace: string, expectedHead: string): Promise<boolean> {
  const observed = await headCommit(workspace);
  if (observed === expectedHead) return false;
  await git(["reset", "--mixed", "-q", expectedHead], workspace);
  const restored = await headCommit(workspace);
  if (restored !== expectedHead) {
    throw new Error(`could not restore Git HEAD after vanilla Developer invocation (expected ${expectedHead}, observed ${restored ?? "none"})`);
  }
  return true;
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
