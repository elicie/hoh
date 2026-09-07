/**
 * The HoH loop (Algorithm 1 of the paper):
 *
 *   E_0 = ∅
 *   for t = 1..T:
 *     D_t = Planner(S, E_{t-1}; read_only(A_{t-1}))
 *     A_t = Developer(A_{t-1}; S, D_t)
 *     E_t = Tester(read_only(A_t); S, D_t, Runtime.check(A_t))
 *
 * The runtime freezes each role's inputs, enforces permissions (tool
 * allowlists, isolated worktree, `.hoh/` guard), binds evidence to the tested
 * candidate (tree hash before/after), and records the resulting state.
 */
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Harness, RoleResult } from "../harness/types.js";
import { CODING_TOOLS, INSPECT_TOOLS, READ_ONLY_TOOLS } from "../harness/types.js";
import type {
  BudgetLedger,
  CheckResult,
  ClaimCatalog,
  CoverageState,
  DeveloperRecord,
  EvidenceBundle,
  EvidenceSubmission,
  Ledger,
  PlannerOverlay,
  PlannerRecord,
  ProtocolReceipt,
  RunConfig,
} from "../types.js";
import { invokeRole, installCapturedTranscript, parseJsonBlock, abortMessage } from "./role.js";
export { parseJsonBlock } from "./role.js";
import { normalizeEvidence } from "./evidence.js";
export { normalizeEvidence } from "./evidence.js";
import { BudgetExhaustedError, BudgetTracker, formatBudgetExhaustion } from "./budget.js";
import { runCheck, runChecks } from "./checks.js";
import { requirePlanApproval, type ApprovePlan } from "./approval.js";
import { buildCandidateDiff } from "./candidate-diff.js";
import { ensureClaimState } from "./claims.js";
import { assertValidConfig, type ConfigPatch, DEFAULT_CONFIG, type HohConfig, mergeConfig, modelForRole } from "./config.js";
import { rebuildCoverage } from "./coverage.js";
import { bindEvidenceFiles, prepareEvidenceDirectory, sanitizeEvidenceDirectory } from "./evidence-files.js";
import {
  artifactTreeHash,
  changedPaths,
  commitAll,
  EMPTY_TREE,
  ensureRepo,
  git,
  headCommit,
  pathsChanged,
  restorePaths,
  ROLE_IDENTITY,
  RUNTIME_IDENTITY,
  worktreeAdd,
  worktreeRemove,
} from "./git.js";
import { applyEvidence, emptyLedger } from "./ledger.js";
import {
  renderDevelopmentDocument,
  renderDeveloperPrompts,
  renderPlannerPrompts,
  renderTesterPrompts,
} from "./prompts.js";
import { buildPromptSnapshot } from "./prompt-snapshot.js";
import { assertProtocolReceiptIntegrity, buildProtocolReceipt, canonicalSha256, hasExplicitProtocol } from "./protocol.js";
import { configuredProviderSecretValues, type ExplicitSecretValues } from "./redaction.js";
import { renderRunReadme, renderTesterReport } from "./report.js";
import { assertSafeRunRecordLayout, refreshRunReceipt, verifyCurrentRunReceipt } from "./run-receipt.js";
import { plannerTools, SUBMIT_EVIDENCE_TOOL, SUBMIT_PLAN_TOOL, testerTools } from "./schemas.js";
import { lastCompletedLoop, loadLedger, loadRun, pad, readJson, RunPaths, writeJson, writeText } from "./state.js";

export type Logger = (message: string) => void;

export type HohExperimentCondition = "hoh" | "no-plan-update" | "no-evidence" | "no-warm-start";

export interface ExperimentA0Identity {
  commit_oid: string;
  /** Full non-.hoh product tree fixed by commit_oid. */
  workspace_tree_oid: string;
  /** Configured artifact subtree identity used for candidates and diffs. */
  tree_oid: string;
  subdir: string;
}

/** Opt-in execution semantics installed only by runExperimentCondition. */
export interface ExperimentLoopPolicy {
  condition: HohExperimentCondition;
  a0: ExperimentA0Identity;
  /** Pre-resolved common contract fixed before any condition role runs. */
  protocolReceipt: ProtocolReceipt;
}

export interface RunOptions {
  workspace: string;
  /** required for a new run; ignored when resuming */
  specPath?: string;
  harness: Harness;
  /**
   * Configuration overrides applied on top of the run's stored `.hoh/config.json`
   * (or the built-in defaults for a new run). The effective config is stored back.
   */
  config?: ConfigPatch;
  /** human-readable origin of `config`, for the record */
  configSource?: string;
  log?: Logger;
  /** Cooperative stop signal propagated through role sessions and deterministic checks. */
  signal?: AbortSignal;
  /** Internal experiment policy. Normal runs must leave this unset. */
  experimentPolicy?: ExperimentLoopPolicy;
  /** Required when human_checkpoint is enabled; return true only after reviewing the supplied plan. */
  approvePlan?: ApprovePlan;
}

export interface LoopResult {
  loopIndex: number;
  planner: PlannerRecord;
  developer: DeveloperRecord;
  evidence: EvidenceBundle;
}

export interface RunResult {
  run: RunConfig;
  results: LoopResult[];
  ledger: Ledger;
  status: "completed" | "budget_exhausted";
  budget: BudgetLedger;
}

interface Ctx {
  ws: string;
  paths: RunPaths;
  run: RunConfig;
  config: HohConfig;
  harness: Harness;
  log: Logger;
  claimCatalog: ClaimCatalog;
  coverage: CoverageState;
  budget: BudgetTracker;
  storageSecrets: ExplicitSecretValues;
  experimentPolicy?: ExperimentLoopPolicy;
  signal?: AbortSignal;
  approvePlan?: ApprovePlan;
}

function assertExperimentLoopPolicy(policy: ExperimentLoopPolicy, config: HohConfig, harness: Harness): void {
  if (!(["hoh", "no-plan-update", "no-evidence", "no-warm-start"] as const).includes(policy.condition)) {
    throw new Error(`unsupported HoH experiment condition ${JSON.stringify(policy.condition)}`);
  }
  if (policy.a0.subdir !== config.artifact_dir) {
    throw new Error(
      `experiment A0 subdir ${JSON.stringify(policy.a0.subdir)} does not match artifact_dir ${JSON.stringify(config.artifact_dir)}`,
    );
  }
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(policy.a0.commit_oid) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(policy.a0.workspace_tree_oid) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(policy.a0.tree_oid)
  ) {
    throw new Error("experiment A0 commit/workspace/artifact tree identities must be full lowercase Git object IDs");
  }
  assertProtocolReceiptIntegrity(policy.protocolReceipt);
  if (
    policy.protocolReceipt.config_sha256 !== canonicalSha256(config) ||
    policy.protocolReceipt.harness.name !== harness.name ||
    policy.protocolReceipt.initial_loops !== config.loops
  ) {
    throw new Error("experiment protocol receipt does not match the supplied common config/harness contract");
  }
}

export async function runHoh(opts: RunOptions): Promise<RunResult> {
  opts.signal?.throwIfAborted();
  const ws = path.resolve(opts.workspace);
  await mkdir(ws, { recursive: true });
  const paths = new RunPaths(ws);
  const log = opts.log ?? (() => {});
  await ensureRepo(ws);
  await assertSafeRunRecordLayout(paths);

  // Validate the previous checkpoint before rewriting any of its inputs.
  // Only repositories predating run receipts may migrate without one.
  const previousRun = await loadRun(paths);
  const hasReceipt = existsSync(paths.receipt);
  const receiptHistory = await git(["log", "-1", "--format=%H", "--", paths.rel(paths.receipt)], ws, { allowFail: true });
  if (hasReceipt || previousRun?.protocol_receipt || receiptHistory.stdout.trim()) {
    const verification = await verifyCurrentRunReceipt(ws);
    if (!verification.ok) {
      throw new Error(`cannot resume: run receipt verification failed: ${verification.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
    }
  }

  // Effective config: stored run config (if any) <- overrides.
  const stored = await readJson<ConfigPatch>(paths.config);
  const base = stored ? mergeConfig(DEFAULT_CONFIG, stored) : DEFAULT_CONFIG;
  const config = mergeConfig(base, opts.config);
  const protocolImplicit = !hasExplicitProtocol(stored) && !hasExplicitProtocol(opts.config);
  const configSource = opts.configSource ?? (stored ? paths.rel(paths.config) : "built-in defaults");
  if (opts.harness.name !== config.harness) {
    throw new Error(`configured harness is "${config.harness}" but a "${opts.harness.name}" harness was supplied`);
  }
  assertValidConfig(config, configSource);
  if (config.human_checkpoint && !opts.approvePlan) throw new Error("human_checkpoint requires an approvePlan callback or an interactive CLI run");
  if (opts.experimentPolicy) assertExperimentLoopPolicy(opts.experimentPolicy, config, opts.harness);

  let run = previousRun;
  let initialized = false;
  if (!run) {
    if (!opts.specPath) throw new Error("A specification file (--spec) is required to start a new run.");
    const protocolReceipt =
      opts.experimentPolicy?.protocolReceipt ??
      (await buildProtocolReceipt(config, opts.harness, { legacyDefault: protocolImplicit, origin: "run_start" }));
    run = {
      schema_version: 1,
      run_id: `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`,
      spec_path: paths.rel(paths.spec),
      created_at: new Date().toISOString(),
      config,
      config_source: configSource,
      protocol_receipt: protocolReceipt,
    };
    await mkdir(paths.root, { recursive: true });
    await copyFile(path.resolve(opts.specPath), paths.spec);
    await writeJson(paths.config, config);
    await writeJson(paths.runJson, run);
    if (opts.harness.providerModels) await writeJson(paths.piModels, opts.harness.providerModels);
    if (opts.harness.resourceManifest) await writeJson(paths.piResources, opts.harness.resourceManifest);
    await writeJson(paths.ledger, emptyLedger());
    initialized = true;
  } else {
    const recordedConfig = mergeConfig(DEFAULT_CONFIG, run.config as ConfigPatch);
    let protocolReceipt = run.protocol_receipt;
    if (protocolReceipt) {
      assertProtocolReceiptIntegrity(protocolReceipt);
    } else {
      const recordedLegacy = !hasExplicitProtocol(run.config);
      if (recordedConfig.protocol === "paper") {
        throw new Error(`cannot resume paper run ${run.run_id}: its run-start protocol receipt is missing`);
      }
      if (recordedConfig.protocol !== config.protocol) {
        throw new Error(
          `cannot change run protocol from ${recordedConfig.protocol} to ${config.protocol}; start a new run in another workspace`,
        );
      }
      protocolReceipt = await buildProtocolReceipt(config, opts.harness, {
        legacyDefault: recordedLegacy,
        origin: "legacy_reconstruction",
      });
    }
    if (protocolReceipt.mode !== config.protocol) {
      throw new Error(
        `cannot change run protocol from ${protocolReceipt.mode} to ${config.protocol}; start a new run in another workspace`,
      );
    }
    if (recordedConfig.artifact_dir !== config.artifact_dir) {
      throw new Error(
        `cannot change artifact_dir from ${JSON.stringify(recordedConfig.artifact_dir)} to ${JSON.stringify(config.artifact_dir)}; candidate tree identity requires a new workspace`,
      );
    }
    if (protocolReceipt.mode === "paper") {
      const requestedReceipt = await buildProtocolReceipt(config, opts.harness, {
        legacyDefault: protocolReceipt.legacy_default,
        origin: protocolReceipt.origin,
        includeResourceContracts: Object.values(protocolReceipt.role_contracts).some((contract) => contract.resources !== undefined),
      });
      if (requestedReceipt.protocol_sha256 !== protocolReceipt.protocol_sha256) {
        throw new Error(
          `cannot resume paper run ${run.run_id}: protocol contract changed (${protocolReceipt.protocol_sha256.slice(0, 12)} -> ${requestedReceipt.protocol_sha256.slice(0, 12)}); start a new run in another workspace`,
        );
      }
    } else {
      protocolReceipt = await buildProtocolReceipt(config, opts.harness, {
        legacyDefault: protocolReceipt.legacy_default,
        origin: protocolReceipt.origin,
      });
    }
    const changed = JSON.stringify(run.config) !== JSON.stringify(config);
    run.config = config;
    run.config_source = configSource;
    run.protocol_receipt = protocolReceipt;
    // The detailed path manifest is a runtime record. For paper runs it is only
    // materialized after the immutable receipt comparison above has succeeded.
    if (opts.harness.providerModels) await writeJson(paths.piModels, opts.harness.providerModels);
    if (opts.harness.resourceManifest) await writeJson(paths.piResources, opts.harness.resourceManifest);
    await writeJson(paths.config, config);
    await writeJson(paths.runJson, run);
    if (changed) {
      await commitAll(ws, `chore(hoh): update configuration (${configSource})`, RUNTIME_IDENTITY, [paths.rel(paths.config), paths.rel(paths.runJson)]);
    }
    log(`resuming run ${run.run_id}${changed ? " with updated configuration" : ""}`);
  }
  const spec = await readFile(paths.spec, "utf8");
  const storageSecrets = configuredProviderSecretValues(config);
  let claimState: Awaited<ReturnType<typeof ensureClaimState>>;
  try {
    claimState = await ensureClaimState({
      workspace: ws,
      specPath: run.spec_path,
      spec,
      harness: opts.harness,
      paths,
      model: modelForRole(config, "planner"),
      expectedModel: run.protocol_receipt?.mode === "paper" ? run.protocol_receipt.models.planner ?? undefined : undefined,
      timeoutMs: config.timeouts.role_min * 60_000,
      signal: opts.signal,
      storageSecrets,
      mode: config.claim_catalog,
    });
  } catch (error) {
    try {
      await refreshRunReceipt(paths, run);
      const message = opts.signal?.aborted ? "checkpoint cancelled initialization" : "checkpoint initialization failure";
      await commitAll(ws, `chore(hoh): ${message}`, RUNTIME_IDENTITY, [".hoh"]);
    } catch (receiptError: any) {
      log(`runtime: WARNING could not checkpoint initialization failure: ${receiptError?.message ?? receiptError}`);
    }
    throw error;
  }
  // The optional loop-0 claim-drafting extension predates RoleUsage accounting.
  // The canonical budget boundary deliberately starts at Planner loop 1.
  const budget = await BudgetTracker.open(paths, config.budgets);
  await writeVerifiedRunCheckpoint(paths, run, await loadLedger(paths));
  if (initialized) {
    await commitAll(ws, `chore(hoh): initialize run ${run.run_id}`, RUNTIME_IDENTITY, ["."]);
    log(`initialized run ${run.run_id} in ${ws} (config: ${configSource})`);
  } else if (claimState.created) {
    log(`generated ${claimState.catalog.claims.length} fixed PRD claim(s)`);
  }
  log(
    `protocol: ${run.protocol_receipt?.mode ?? config.protocol}${run.protocol_receipt?.legacy_default ? " (legacy default)" : ""} ${run.protocol_receipt?.protocol_sha256.slice(0, 12) ?? "unrecorded"}; models: ${(["planner", "developer", "tester"] as const).map((r) => `${r}=${modelForRole(config, r) ?? "(harness default)"}`).join(", ")}; budget ${config.loops} loops`,
  );

  // Runtime-owned records regenerated at start-up (provider file, run/config) are committed by the runtime,
  // so that they are never attributed to a role.
  await commitAll(ws, "chore(hoh): update run records", RUNTIME_IDENTITY, [".hoh", ":(exclude).hoh/iterations"]);

  // Visible to checks and to the roles' shells (pi's bash inherits the runtime environment).
  process.env.HOH_WORKSPACE = ws;
  process.env.HOH_RUN_ID = run.run_id;
  await git(["worktree", "prune"], ws, { allowFail: true });

  const ctx: Ctx = {
    ws,
    paths,
    run,
    config,
    harness: opts.harness,
    log,
    claimCatalog: claimState.catalog,
    coverage: claimState.coverage,
    budget,
    storageSecrets,
    experimentPolicy: opts.experimentPolicy,
    approvePlan: opts.approvePlan,
    signal: opts.signal,
  };
  const done = await lastCompletedLoop(paths);
  const results: LoopResult[] = [];
  try {
    for (let t = done + 1; t <= config.loops; t++) {
      results.push(await runLoop(ctx, t));
      await budget.endLoop(t);
      await writeVerifiedRunCheckpoint(paths, run, await loadLedger(paths));
      await commitAll(ws, `chore(loop-${pad(t)}): checkpoint run receipt`, RUNTIME_IDENTITY, [
        paths.rel(paths.budget),
        paths.rel(paths.readme),
        paths.rel(paths.receipt),
      ]);
    }
  } catch (error) {
    if (!(error instanceof BudgetExhaustedError)) {
      try {
        await writeVerifiedRunCheckpoint(paths, run, await loadLedger(paths));
        await commitAll(ws, opts.signal?.aborted ? "chore(hoh): checkpoint cancelled run receipt" : "chore(hoh): checkpoint failed run receipt", RUNTIME_IDENTITY, [".hoh"]);
      } catch (receiptError: any) {
        log(`runtime: WARNING could not refresh failed run receipt: ${receiptError?.message ?? receiptError}`);
      }
      throw error;
    }
    const budgetLedger = await budget.finish(false);
    await writeVerifiedRunCheckpoint(paths, run, await loadLedger(paths));
    await commitAll(ws, `chore(hoh): ${error.message}`, RUNTIME_IDENTITY, [".hoh"]);
    log(`BUDGET_EXHAUSTED ${formatBudgetExhaustion(error.exhaustion)}`);
    return { run, results, ledger: await loadLedger(paths), status: "budget_exhausted", budget: budgetLedger };
  }
  if (done >= config.loops) log(`all ${config.loops} loops already completed; nothing to do`);
  const budgetLedger = await budget.finish(true);
  await writeVerifiedRunCheckpoint(paths, run, await loadLedger(paths));
  await commitAll(ws, "chore(hoh): finalize run accounting", RUNTIME_IDENTITY, [
    paths.rel(paths.budget),
    paths.rel(paths.readme),
    paths.rel(paths.receipt),
  ]);
  return {
    run,
    results,
    ledger: await loadLedger(paths),
    status: budgetLedger.status === "budget_exhausted" ? "budget_exhausted" : "completed",
    budget: budgetLedger,
  };
}

// ---------------------------------------------------------------------------

export async function runLoop(ctx: Ctx, t: number): Promise<LoopResult> {
  ctx.signal?.throwIfAborted();
  const { ws, paths, run, config, log } = ctx;
  const tag = `[loop ${pad(t)}]`;
  const roleTimeoutMs = config.timeouts.role_min * 60_000;
  const loopDir = paths.loopDir(t);
  await mkdir(path.join(loopDir, "transcripts"), { recursive: true });

  try {
    await ctx.budget.startLoop(t);
    const spec = await readFile(paths.spec, "utf8");
    const artifactDir = config.artifact_dir;
    const artifactAbs = path.resolve(ws, artifactDir);
    await mkdir(artifactAbs, { recursive: true });
    const ledger = await loadLedger(paths);
    const previousEvidence = t > 1 ? await readJson<EvidenceBundle>(paths.evidenceJson(t - 1)) : null;
    const previousDeveloper = t > 1 ? await readJson<DeveloperRecord>(paths.developerJson(t - 1)) : null;
    const previousChecks = previousEvidence?.checks ?? null;
    const fixedA0 = ctx.experimentPolicy?.condition === "no-warm-start" ? ctx.experimentPolicy.a0 : null;
    // A run may start from a provided artifact (warm start at loop 1): identify it like any other candidate.
    const initialTree = t === 1 ? await artifactTreeHash(ws, { subdir: artifactDir }) : null;
    const baseCandidateId = fixedA0
      ? `loop-00-${fixedA0.tree_oid.slice(0, 12)}`
      : previousDeveloper?.candidate_id ?? (initialTree && initialTree !== EMPTY_TREE ? `loop-00-${initialTree.slice(0, 12)}` : null);

    process.env.HOH_LOOP = String(t);

    // ------------------------------------------------------------- PLAN (D_t)
    let planner = await readJson<PlannerRecord>(paths.plannerJson(t));
    let developmentDocument = planner ? await readFile(paths.developmentDocument(t), "utf8").catch(() => null) : null;
    let overlay: PlannerOverlay;
    if (ctx.experimentPolicy?.condition === "no-plan-update" && t > 1) {
      const firstPlanner = await readJson<PlannerRecord>(paths.plannerJson(1));
      const firstDocument = await readFile(paths.developmentDocument(1), "utf8").catch(() => null);
      if (!firstPlanner || firstDocument === null) {
        throw new Error("no-plan-update requires the recorded loop-1 development document");
      }
      planner = firstPlanner;
      overlay = firstPlanner;
      developmentDocument = firstDocument;
      await copyFile(paths.developmentDocument(1), paths.developmentDocument(t));
      await commitAll(
        ws,
        `chore(loop-${pad(t)}): reuse fixed loop-1 development document`,
        RUNTIME_IDENTITY,
        [paths.rel(paths.developmentDocument(t))],
      );
      log(`${tag} planner: reusing loop-1 development document (no-plan-update)`);
    } else if (planner && developmentDocument) {
      overlay = planner;
      log(`${tag} planner: reusing recorded development document (resume)`);
    } else {
    process.env.HOH_ROLE = "planner";
    log(`${tag} planner: start (base ${baseCandidateId ?? "none"})`);
    const omitPlannerEvidence = ctx.experimentPolicy?.condition === "no-evidence";
    const plannerLedger = omitPlannerEvidence ? emptyLedger() : ledger;
    const plannerCoverage = omitPlannerEvidence
      ? { schema_version: 1 as const, claim_catalog_sha256: ctx.coverage.claim_catalog_sha256, claims: {} }
      : ctx.coverage;
    const plannerView = omitPlannerEvidence ? await prepareNoEvidencePlannerView(ctx, t) : null;
    const plannerCwd = plannerView?.cwd ?? ws;
    let plannerPrompts: Awaited<ReturnType<typeof renderPlannerPrompts>>;
    let plannerRun: Awaited<ReturnType<typeof invokeRole>>;
    try {
      plannerPrompts = await renderPlannerPrompts({
        loopIndex: t,
        cwd: plannerCwd,
        artifactDir,
        specPath: run.spec_path,
        spec,
        baseCandidateId,
        previousEvidence: omitPlannerEvidence ? null : previousEvidence,
        previousChecks: omitPlannerEvidence ? null : previousChecks,
        ledger: plannerLedger,
        claimCatalog: ctx.claimCatalog,
        coverage: plannerCoverage,
      });
      plannerRun = await invokeRole(
        ctx,
        {
          role: "planner",
          loopIndex: t,
          cwd: plannerCwd,
          systemPrompt: plannerPrompts.system,
          prompt: plannerPrompts.user,
          tools: READ_ONLY_TOOLS,
          structuredTools: plannerTools,
          transcriptPath: paths.transcript(t, "planner"),
          timeoutMs: roleTimeoutMs,
          model: modelForRole(config, "planner"),
        },
        SUBMIT_PLAN_TOOL,
      );
    } finally {
      if (plannerView) await plannerView.cleanup();
    }
    const validated = validateOverlay(lastSubmission<PlannerOverlay>(plannerRun.result, SUBMIT_PLAN_TOOL) ?? parseJsonBlock<PlannerOverlay>(plannerRun.result.finalText));
    // The planner is read-only by tool allowlist; still assert nothing changed.
    const artifactSpec = [".", ":(exclude).hoh"];
    const plannerChanges = await pathsChanged(ws, artifactSpec);
    if (plannerChanges.length) {
      log(`${tag} planner: WARNING workspace changed during planning (${plannerChanges.length} paths); reverting`);
      await restorePaths(ws, artifactSpec);
    }
    await installCapturedTranscript(plannerRun.transcript, ctx.storageSecrets);
    await writeJson(
      paths.promptSnapshot(t, "planner"),
      buildPromptSnapshot({
        role: "planner",
        loopIndex: t,
        finalAttempt: plannerRun.attempts,
        systemPrompt: plannerRun.finalSystemPrompt,
        userPrompt: plannerRun.finalUserPrompt,
        explicitSecrets: ctx.storageSecrets,
      }),
    );
    if (!validated) {
      throw new Error(`planner returned no development document after ${plannerRun.attempts} attempt(s)`);
    }
    overlay = validated;
    planner = {
      ...overlay,
      schema_version: 1,
      loop_index: t,
      base_candidate_id: baseCandidateId,
      attempts: plannerRun.attempts,
      usage: plannerRun.usage,
      created_at: new Date().toISOString(),
    };
    developmentDocument = renderDevelopmentDocument({
      loopIndex: t,
      baseCandidateId,
      overlay,
      previousEvidence: omitPlannerEvidence ? null : previousEvidence,
      ledger: plannerLedger,
      previousChecks: omitPlannerEvidence ? null : previousChecks,
    });
    await writeJson(paths.plannerJson(t), planner);
    await writeText(paths.developmentDocument(t), developmentDocument);
    await commitAll(ws, `docs(loop-${pad(t)}): ${oneLine(overlay.objective)}`, ROLE_IDENTITY.planner, [".hoh"]);
    log(`${tag} planner: done — ${oneLine(overlay.objective)}`);
    }

    // ---------------------------------------------------------- DEVELOP (A_t)
    if (config.human_checkpoint) {
      developmentDocument = await readFile(paths.developmentDocument(t), "utf8");
      log(`${tag} awaiting human approval of the development plan`);
      await ctx.budget.pauseLoop(t);
      try {
        await requirePlanApproval({ loopIndex: t, documentPath: paths.developmentDocument(t), document: developmentDocument, signal: ctx.signal },
          path.join(loopDir, "approval.json"), run.protocol_receipt!.protocol_sha256, ctx.approvePlan!);
      } finally {
        await ctx.budget.startLoop(t);
      }
      await commitAll(ws, `chore(loop-${pad(t)}): record human plan approval`, RUNTIME_IDENTITY, [paths.rel(path.join(loopDir, "approval.json"))]);
    }
    let developer = await readJson<DeveloperRecord>(paths.developerJson(t));
    if (developer) {
      // The candidate identity is the artifact tree, so runtime-only commits (error records) after it are fine.
      const tree = await artifactTreeHash(ws, { subdir: artifactDir });
      if (tree !== developer.candidate_tree_sha) {
        throw new Error(`cannot resume loop ${t}: artifact tree ${tree.slice(0, 12)} differs from the recorded candidate ${developer.candidate_id}`);
      }
      log(`${tag} developer: reusing recorded candidate ${developer.candidate_id} (resume)`);
    } else {
    process.env.HOH_ROLE = "developer";
    if (fixedA0) {
      await restoreArtifactAtCommit(ws, ".", fixedA0.commit_oid);
      const restoredWorkspaceTree = await artifactTreeHash(ws, { subdir: "." });
      if (restoredWorkspaceTree !== fixedA0.workspace_tree_oid) {
        throw new Error(
          `no-warm-start full A0 restore produced ${restoredWorkspaceTree.slice(0, 12)}, expected ${fixedA0.workspace_tree_oid.slice(0, 12)}`,
        );
      }
      const restoredTree = await artifactTreeHash(ws, { subdir: artifactDir });
      if (restoredTree !== fixedA0.tree_oid) {
        throw new Error(
          `no-warm-start A0 restore produced ${restoredTree.slice(0, 12)}, expected ${fixedA0.tree_oid.slice(0, 12)}`,
        );
      }
    }
    const preDevelopmentCommit = fixedA0?.commit_oid ?? (await headCommit(ws));
    if (!preDevelopmentCommit) throw new Error(`cannot start Developer for loop ${t}: workspace has no base commit`);
    const recordSpec = [".hoh"];
    // Anything already dirty under .hoh before the developer starts belongs to the runtime, not to the developer.
    const dirtyBefore = new Set(await pathsChanged(ws, recordSpec, { includeIgnored: Boolean(ctx.experimentPolicy) }));
    log(`${tag} developer: start`);
    const developerView = fixedA0 ? await prepareNoWarmDeveloperView(ctx, t) : null;
    const developerCwd = developerView?.cwd ?? ws;
    let developerPrompts: Awaited<ReturnType<typeof renderDeveloperPrompts>>;
    let developerRun: Awaited<ReturnType<typeof invokeRole>>;
    let developerHeadMoved = false;
    try {
      developerPrompts = await renderDeveloperPrompts({
        loopIndex: t,
        cwd: developerCwd,
        artifactDir,
        specPath: run.spec_path,
        spec,
        devDocPath: paths.rel(paths.developmentDocument(t)),
        developmentDocument,
        baseCandidateId,
        previousChangedPaths: fixedA0 ? [] : previousDeveloper?.changed_paths ?? [],
      });
      developerRun = await invokeRole(ctx, {
        role: "developer",
        loopIndex: t,
        cwd: developerCwd,
        systemPrompt: developerPrompts.system,
        prompt: developerPrompts.user,
        tools: CODING_TOOLS,
        structuredTools: [],
        transcriptPath: paths.transcript(t, "developer"),
        timeoutMs: roleTimeoutMs,
        model: modelForRole(config, "developer"),
      });
      if (developerView) developerHeadMoved = await developerView.install();
    } finally {
      if (!developerView && ctx.experimentPolicy) {
        developerHeadMoved = await reanchorRoleHead(ws, preDevelopmentCommit);
      }
      if (developerView) await developerView.cleanup();
    }
    const violations: string[] = developerHeadMoved ? ["moved Git HEAD during Developer invocation (re-anchored)"] : [];
    // Runtime records are off limits to the Developer; the runtime's own transcript for this loop is not a violation.
    const budgetRel = paths.rel(paths.budget).replaceAll(path.sep, "/");
    const hohChanges = (await pathsChanged(ws, recordSpec, { includeIgnored: Boolean(ctx.experimentPolicy) })).filter(
      (p) => !dirtyBefore.has(p) && p.replaceAll(path.sep, "/") !== budgetRel,
    );
    if (hohChanges.length) {
      violations.push(...hohChanges.map((p) => `modified runtime record ${p} (reverted)`));
      await restorePaths(ws, hohChanges.map((p) => `:(literal)${p}`), { includeIgnored: Boolean(ctx.experimentPolicy) });
      log(`${tag} developer: WARNING reverted ${hohChanges.length} change(s) under .hoh/`);
    }
    await installCapturedTranscript(developerRun.transcript, ctx.storageSecrets);
    // The harness writes the current transcript while the Developer runs, and
    // a shell-enabled Developer can stage it (or any other runtime record).
    // Keep all .hoh entries out of the candidate index; the runtime commits its
    // own records at the later pre-QA boundary.
    await git(["reset", "-q", "HEAD", "--", ".hoh"], ws, { allowFail: true });
    const commit = await commitAll(ws, `feat(loop-${pad(t)}): ${oneLine(overlay.objective)}`, ROLE_IDENTITY.developer, [".", ":(exclude).hoh"]);
    const tree = await artifactTreeHash(ws, { subdir: artifactDir });
    const newCandidateId = `loop-${pad(t)}-${tree.slice(0, 12)}`;
    const candidateCommit = commit ?? preDevelopmentCommit;
    developer = {
      schema_version: 1,
      loop_index: t,
      base_candidate_id: baseCandidateId,
      candidate_id: newCandidateId,
      candidate_tree_sha: tree,
      base_commit_sha: preDevelopmentCommit,
      candidate_commit_sha: candidateCommit,
      artifact_subdir: artifactDir,
      commit,
      changed_paths: commit ? (await changedPaths(ws, preDevelopmentCommit, commit)).filter((p) => !p.startsWith(".hoh/")) : [],
      summary: developerRun.result.finalText,
      violations,
      usage: developerRun.usage,
      created_at: new Date().toISOString(),
    };
    await writeJson(paths.developerJson(t), developer);
    await writeJson(
      paths.promptSnapshot(t, "developer"),
      buildPromptSnapshot({
        role: "developer",
        loopIndex: t,
        finalAttempt: developerRun.attempts,
        systemPrompt: developerRun.finalSystemPrompt,
        userPrompt: developerRun.finalUserPrompt,
        explicitSecrets: ctx.storageSecrets,
      }),
    );
    log(`${tag} developer: done — candidate ${newCandidateId}, ${developer.changed_paths.length} path(s) changed${commit ? "" : " (no commit)"}`);
    }
    const candidateId = developer.candidate_id;
    const commitRange = await resolveDeveloperCommitRange(ws, developer);

    // ------------------------------------------------- CHECK + TEST (E_t)
    ctx.signal?.throwIfAborted();
    // Do not pay for worktree setup/checks when a completed Planner or
    // Developer has already exhausted a role, loop, or run boundary.
    await ctx.budget.assertCanStartRole(t, "tester");
    process.env.HOH_ROLE = "tester";
    const wt = await mkdtemp(path.join(os.tmpdir(), `hoh-${run.run_id}-loop-${pad(t)}-`));
    const evidenceDir = paths.evidenceDir(t);
    await prepareEvidenceDirectory(evidenceDir);
    let evidence: EvidenceBundle;
    let evidenceBound = false;
    let qaFailed = false;
    try {
      await worktreeAdd(ws, commitRange.candidateCommit, wt);
      const wtArtifact = path.resolve(wt, artifactDir);
      await mkdir(wtArtifact, { recursive: true });
      const candidateBeforeChecks = await artifactTreeHash(wt, { subdir: artifactDir });
      if (candidateBeforeChecks !== developer.candidate_tree_sha) {
        throw new Error(
          `candidate worktree ${candidateBeforeChecks.slice(0, 12)} differs from recorded candidate ${developer.candidate_tree_sha.slice(0, 12)} before checks`,
        );
      }
      const candidateDiff = await buildCandidateDiff(wt, {
        baseCommit: commitRange.baseCommit,
        candidateCommit: commitRange.candidateCommit,
        artifactDir,
      });
      const checkEnv = {
        HOH_WORKSPACE: ws,
        HOH_CANDIDATE_DIR: wt,
        HOH_EVIDENCE_DIR: evidenceDir,
        HOH_RUN_ID: run.run_id,
        HOH_LOOP: String(t),
        HOH_ROLE: "check",
      };
      log(`${tag} runtime: ${config.checks.length} deterministic check(s) on frozen candidate${config.worktree_setup ? " (with worktree setup)" : ""}`);
      const checks: CheckResult[] = [];
      if (config.worktree_setup) {
        checks.push(
          await runCheck(
            { name: "setup", command: config.worktree_setup },
            wt,
            config.timeouts.check_min * 60_000,
            checkEnv,
            { directory: evidenceDir, basename: "00-setup" },
            ctx.signal,
          ),
        );
      }
      checks.push(...(await runChecks(config.checks, wtArtifact, config.timeouts.check_min * 60_000, checkEnv, ctx.signal)));
      for (const c of checks) {
        const lastLine = (c.stderr_tail || c.stdout_tail).trim().split("\n").filter(Boolean).pop() ?? "";
        log(`${tag} check ${c.name}: ${c.status} (${(c.duration_ms / 1000).toFixed(1)}s)${c.status === "pass" ? "" : ` — ${lastLine.slice(0, 160)}`}`);
      }
      process.env.HOH_CANDIDATE_DIR = wt;
      process.env.HOH_EVIDENCE_DIR = evidenceDir;
      await writeJson(paths.checksJson(t), checks);
      const before = await artifactTreeHash(wt, { subdir: artifactDir });
      await git(["add", "-f", "--", paths.rel(evidenceDir)], ws, { allowFail: true });
      await commitAll(
        ws,
        `chore(loop-${pad(t)}): freeze deterministic check records`,
        RUNTIME_IDENTITY,
        [
          paths.rel(paths.developerJson(t)),
          paths.rel(paths.promptSnapshot(t, "developer")),
          paths.rel(paths.transcript(t, "developer")),
          paths.rel(paths.checksJson(t)),
          paths.rel(evidenceDir),
        ],
      );

      log(`${tag} tester: start`);
      ctx.signal?.throwIfAborted();
      const testerPrompts = await renderTesterPrompts({
        loopIndex: t,
        cwd: wt,
        artifactDir,
        spec,
        candidateId,
        baseCandidateId,
        candidateDiff,
        developmentDocument,
        checks,
        checksPath: paths.checksJson(t),
        claimCatalog: ctx.claimCatalog,
        coverage: ctx.coverage,
      });
      const testerRun = await invokeRole(
        ctx,
        {
          role: "tester",
          evidenceDir,
          loopIndex: t,
          cwd: wt,
          systemPrompt: testerPrompts.system,
          prompt: testerPrompts.user,
          tools: INSPECT_TOOLS,
          structuredTools: testerTools,
          transcriptPath: paths.transcript(t, "tester"),
          timeoutMs: roleTimeoutMs,
          model: modelForRole(config, "tester"),
        },
        SUBMIT_EVIDENCE_TOOL,
      );
      ctx.signal?.throwIfAborted();
      const after = await artifactTreeHash(wt, { subdir: artifactDir });
      ctx.signal?.throwIfAborted();
      // The Tester works in the worktree, but bash could still reach the main workspace by absolute path.
      const testerGuardSpec = [".", ":(exclude).hoh"];
      const testerWorkspaceChanges = await pathsChanged(ws, testerGuardSpec);
      if (testerWorkspaceChanges.length) {
        log(`${tag} tester: WARNING main workspace changed during QA (${testerWorkspaceChanges.length} paths); reverting`);
        await restorePaths(ws, testerGuardSpec);
      }
      const evidenceRel = paths.rel(evidenceDir).replaceAll(path.sep, "/");
      const immutableCheckRel = `${evidenceRel}/checks/`;
      const testerRuntimeChanges = (await pathsChanged(ws, [".hoh"], { includeIgnored: true })).filter((changed) => {
        const rel = changed.replaceAll(path.sep, "/");
        if (rel === paths.rel(paths.budget).replaceAll(path.sep, "/")) return false;
        if (rel.startsWith(`${evidenceRel}/`) && !rel.startsWith(immutableCheckRel)) return false;
        return true;
      });
      if (testerRuntimeChanges.length) {
        log(`${tag} tester: WARNING runtime records changed outside the evidence area (${testerRuntimeChanges.length} paths); reverting`);
        await restorePaths(
          ws,
          testerRuntimeChanges.map((changed) => `:(literal)${changed}`),
          { includeIgnored: true },
        );
      }
      const testerViolations = [...testerWorkspaceChanges, ...testerRuntimeChanges];
      await installCapturedTranscript(testerRun.transcript, ctx.storageSecrets);
      await writeJson(
        paths.promptSnapshot(t, "tester"),
        buildPromptSnapshot({
          role: "tester",
          loopIndex: t,
          finalAttempt: testerRun.attempts,
          systemPrompt: testerRun.finalSystemPrompt,
          userPrompt: testerRun.finalUserPrompt,
          explicitSecrets: ctx.storageSecrets,
        }),
      );
      const submission =
        lastSubmission<EvidenceSubmission>(testerRun.result, SUBMIT_EVIDENCE_TOOL) ?? parseJsonBlock<EvidenceSubmission>(testerRun.result.finalText);
      ctx.signal?.throwIfAborted();
      evidence = await bindEvidenceFiles(
        normalizeEvidence({
          submission,
          loopIndex: t,
          candidateId,
          checks,
          before,
          after,
          finalText: testerRun.result.finalText,
          usage: testerRun.usage,
          attempts: testerRun.attempts,
          workspaceViolations: testerViolations,
          claimCatalog: ctx.claimCatalog,
          expectedCandidateSha: developer.candidate_tree_sha,
        }),
        evidenceDir,
        ctx.claimCatalog,
        testerRun.result.executions,
      );
      ctx.signal?.throwIfAborted();
      evidenceBound = true;
    } catch (error) {
      qaFailed = true;
      throw error;
    } finally {
      let cleanupFailed = false;
      let cleanupFailure: unknown;
      try {
        if (!evidenceBound) {
          const notes = await sanitizeEvidenceDirectory(evidenceDir);
          for (const note of notes) log(`${tag} runtime: ${note}`);
        }
      } catch (error) {
        cleanupFailed = true;
        cleanupFailure = error;
      }
      try {
        await worktreeRemove(ws, wt);
      } catch (error) {
        if (!cleanupFailed) cleanupFailure = error;
        cleanupFailed = true;
      } finally {
        delete process.env.HOH_CANDIDATE_DIR;
        delete process.env.HOH_EVIDENCE_DIR;
      }
      if (cleanupFailed) {
        if (!qaFailed && !ctx.signal?.aborted) throw cleanupFailure;
        log(`${tag} runtime: WARNING QA cleanup also failed: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`);
      }
    }

    ctx.signal?.throwIfAborted();
    const delta = applyEvidence(ledger, evidence);
    await rm(paths.errorJson(t), { force: true }); // a previous failed attempt of this loop is superseded
    await writeJson(paths.ledger, ledger);
    await writeJson(paths.checksJson(t), evidence.checks);
    await writeJson(paths.evidenceJson(t), evidence);
    if (ctx.claimCatalog.claims.length) {
      ctx.coverage = await rebuildCoverage(paths, ctx.claimCatalog);
      await writeJson(paths.coverage, ctx.coverage);
    }
    await writeText(paths.testerReport(t), renderTesterReport(evidence));
    await writeText(paths.readme, await renderRunReadme(paths, run, ledger));
    await git(["add", "-f", "--", paths.rel(evidenceDir)], ws, { allowFail: true });
    await commitAll(ws, `test(loop-${pad(t)}): QA ${evidence.qa_status} for ${candidateId}`, ROLE_IDENTITY.tester, [".hoh"]);
    log(
      `${tag} tester: ${evidence.qa_status.toUpperCase()} — verified ${evidence.verified_records.length}, gaps ${evidence.gap_records.length}` +
        ` (ledger: +${delta.opened.length} opened, ${delta.reopened.length} regressed, ${delta.closed.length} closed)` +
        (evidence.frozen ? "" : " — CANDIDATE MUTATED DURING QA"),
    );

    return { loopIndex: t, planner, developer, evidence };
  } catch (err: any) {
    try {
      await ctx.budget.pauseLoop(t);
    } catch (budgetWriteError: any) {
      log(`${tag} runtime: WARNING could not persist elapsed budget state: ${budgetWriteError?.message ?? budgetWriteError}`);
    }
    // A failed shell-enabled role may have staged arbitrary workspace paths.
    // Keep those working-tree changes available for a Developer retry, but
    // clear the shared index so the runtime error commit can contain only .hoh.
    await git(["reset", "-q", "HEAD", "--", "."], ws);
    if (ctx.signal?.aborted) {
      log(`${tag} CANCELLED ${abortMessage(err, ctx.signal)}`);
      throw ctx.signal.reason ?? err;
    }
    if (err instanceof BudgetExhaustedError) {
      log(`${tag} BUDGET_EXHAUSTED ${formatBudgetExhaustion(err.exhaustion)}`);
      throw err;
    }
    const message = err?.stack ?? String(err);
    await writeJson(paths.errorJson(t), { loop_index: t, message: err?.message ?? String(err), stack: message, at: new Date().toISOString() });
    try {
      await writeVerifiedRunCheckpoint(paths, run, await loadLedger(paths));
    } catch (receiptError: any) {
      log(`${tag} runtime: WARNING could not refresh failed run receipt: ${receiptError?.message ?? receiptError}`);
    }
    await commitAll(ws, `chore(loop-${pad(t)}): runtime error`, RUNTIME_IDENTITY, [".hoh"]);
    log(`${tag} ERROR ${err?.message ?? err}`);
    throw err;
  }
}

async function writeVerifiedRunCheckpoint(paths: RunPaths, run: RunConfig, ledger: Ledger): Promise<void> {
  await refreshRunReceipt(paths, run);
  const verification = await verifyCurrentRunReceipt(paths.workspace);
  if (!verification.ok) {
    throw new Error(`new run receipt failed verification: ${verification.issues.map((issue) => issue.code).join(", ")}`);
  }
  await writeText(paths.readme, await renderRunReadme(paths, run, ledger, { receiptVerification: verification }));
}

// ---------------------------------------------------------------------------
// Structured role output
// ---------------------------------------------------------------------------

function lastSubmission<T>(result: RoleResult, tool: string): T | null {
  const list = result.submissions[tool];
  return list && list.length ? (list[list.length - 1] as T) : null;
}

function validateOverlay(o: PlannerOverlay | null): PlannerOverlay | null {
  if (!o || typeof o !== "object") return null;
  if (typeof o.objective !== "string" || !Array.isArray(o.priorities) || o.priorities.length === 0) return null;
  return {
    objective: o.objective.trim(),
    priorities: o.priorities.slice(0, 3).map((p) => ({
      name: String(p?.name ?? "").trim() || "priority",
      action: String(p?.action ?? "").trim(),
      observable_outcome: String(p?.observable_outcome ?? "").trim(),
    })),
    preservation_gate: Array.isArray(o.preservation_gate) ? o.preservation_gate.map(String) : [],
    acceptance_gate: Array.isArray(o.acceptance_gate) ? o.acceptance_gate.map(String) : [],
  };
}

// ---------------------------------------------------------------------------
// Candidate and isolated role workspaces
// ---------------------------------------------------------------------------

/** Recover the exact Developer range while remaining compatible with pre-range records. */
async function resolveDeveloperCommitRange(
  workspace: string,
  developer: DeveloperRecord,
): Promise<{ baseCommit: string; candidateCommit: string }> {
  const candidateCommit = developer.candidate_commit_sha ?? developer.commit ?? (await headCommit(workspace));
  if (!candidateCommit) throw new Error(`candidate ${developer.candidate_id} has no Git commit`);
  if (developer.base_commit_sha) return { baseCommit: developer.base_commit_sha, candidateCommit };
  if (!developer.commit) return { baseCommit: candidateCommit, candidateCommit };

  const parent = await git(["rev-parse", "--verify", `${developer.commit}^`], workspace, { allowFail: true });
  if (parent.code !== 0 || !parent.stdout.trim()) {
    throw new Error(`cannot reconstruct the base commit for legacy candidate ${developer.candidate_id}`);
  }
  return { baseCommit: parent.stdout.trim(), candidateCommit };
}

async function prepareNoEvidencePlannerView(ctx: Ctx, loopIndex: number): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `hoh-${ctx.run.run_id}-no-evidence-plan-${pad(loopIndex)}-`));
  const previousWorkspace = process.env.HOH_WORKSPACE;
  try {
    for (const entry of await readdir(ctx.ws, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".hoh") continue;
      await cp(path.join(ctx.ws, entry.name), path.join(cwd, entry.name), {
        recursive: entry.isDirectory(),
        preserveTimestamps: true,
      });
    }
    // A standalone one-snapshot repository prevents prior evidence from being
    // recovered through linked-worktree Git metadata or object history.
    await ensureRepo(cwd);
    let snapshotCommit = await commitAll(cwd, "chore(experiment): install no-evidence planner snapshot", RUNTIME_IDENTITY, ["."]);
    if (!snapshotCommit) {
      await git(["commit", "-q", "--allow-empty", "--no-verify", "-m", "chore(experiment): install empty planner snapshot"], cwd, {
        env: {
          GIT_AUTHOR_NAME: RUNTIME_IDENTITY.name,
          GIT_AUTHOR_EMAIL: RUNTIME_IDENTITY.email,
          GIT_COMMITTER_NAME: RUNTIME_IDENTITY.name,
          GIT_COMMITTER_EMAIL: RUNTIME_IDENTITY.email,
        },
      });
      snapshotCommit = await headCommit(cwd);
    }
    if (!snapshotCommit) throw new Error(`cannot initialize no-evidence Planner snapshot for loop ${loopIndex}`);

    // Only the public specification and its spec-derived fixed catalog remain
    // under .hoh. Prior checks, evidence, ledger, coverage, condition metadata,
    // and their Git history are absent from this Planner filesystem view.
    await mkdir(path.join(cwd, ".hoh"), { recursive: true });
    await copyFile(ctx.paths.spec, path.join(cwd, ctx.run.spec_path));
    try {
      if (ctx.claimCatalog.claims.length) await copyFile(ctx.paths.claims, path.join(cwd, ctx.paths.rel(ctx.paths.claims)));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    process.env.HOH_WORKSPACE = cwd;
    return {
      cwd,
      cleanup: async () => {
        if (previousWorkspace === undefined) delete process.env.HOH_WORKSPACE;
        else process.env.HOH_WORKSPACE = previousWorkspace;
        await rm(cwd, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (previousWorkspace === undefined) delete process.env.HOH_WORKSPACE;
    else process.env.HOH_WORKSPACE = previousWorkspace;
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

async function prepareNoWarmDeveloperView(
  ctx: Ctx,
  loopIndex: number,
): Promise<{ cwd: string; install: () => Promise<boolean>; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `hoh-${ctx.run.run_id}-a0-develop-${pad(loopIndex)}-`));
  const previousWorkspace = process.env.HOH_WORKSPACE;
  try {
    for (const entry of await readdir(ctx.ws, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".hoh") continue;
      await cp(path.join(ctx.ws, entry.name), path.join(cwd, entry.name), {
        recursive: entry.isDirectory(),
        preserveTimestamps: true,
      });
    }
    await ensureRepo(cwd);
    let baselineCommit = await commitAll(cwd, "chore(experiment): install isolated A0", RUNTIME_IDENTITY, ["."]);
    if (!baselineCommit) {
      await git(["commit", "-q", "--allow-empty", "--no-verify", "-m", "chore(experiment): install empty isolated A0"], cwd, {
        env: {
          GIT_AUTHOR_NAME: RUNTIME_IDENTITY.name,
          GIT_AUTHOR_EMAIL: RUNTIME_IDENTITY.email,
          GIT_COMMITTER_NAME: RUNTIME_IDENTITY.name,
          GIT_COMMITTER_EMAIL: RUNTIME_IDENTITY.email,
        },
      });
      baselineCommit = await headCommit(cwd);
    }
    if (!baselineCommit) throw new Error(`cannot initialize isolated A0 Developer view for loop ${loopIndex}`);

    const isolatedSpec = path.join(cwd, ctx.run.spec_path);
    const isolatedDocument = path.join(cwd, ctx.paths.rel(ctx.paths.developmentDocument(loopIndex)));
    await mkdir(path.dirname(isolatedSpec), { recursive: true });
    await mkdir(path.dirname(isolatedDocument), { recursive: true });
    await copyFile(ctx.paths.spec, isolatedSpec);
    await copyFile(ctx.paths.developmentDocument(loopIndex), isolatedDocument);
    process.env.HOH_WORKSPACE = cwd;

    return {
      cwd,
      install: async () => {
        const headMoved = await reanchorRoleHead(cwd, baselineCommit);
        await git(["reset", "-q", "HEAD", "--", ".hoh"], cwd, { allowFail: true });
        await commitAll(cwd, `feat(loop-${pad(loopIndex)}): isolated A0 development result`, ROLE_IDENTITY.developer, [
          ".",
          ":(exclude).hoh",
        ]);
        const isolatedCandidate = await headCommit(cwd);
        if (!isolatedCandidate) throw new Error(`isolated A0 Developer loop ${loopIndex} produced no candidate commit`);
        await git(["fetch", "-q", "--no-tags", cwd, isolatedCandidate], ctx.ws);
        await restoreArtifactAtCommit(ctx.ws, ".", isolatedCandidate);
        return headMoved;
      },
      cleanup: async () => {
        if (previousWorkspace === undefined) delete process.env.HOH_WORKSPACE;
        else process.env.HOH_WORKSPACE = previousWorkspace;
        await rm(cwd, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (previousWorkspace === undefined) delete process.env.HOH_WORKSPACE;
    else process.env.HOH_WORKSPACE = previousWorkspace;
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

/** Preserve role-produced files while returning Git history to the fixed pre-role parent. */
async function reanchorRoleHead(workspace: string, expectedHead: string): Promise<boolean> {
  const observed = await headCommit(workspace);
  if (observed === expectedHead) return false;
  await git(["reset", "--mixed", "-q", expectedHead], workspace);
  const restored = await headCommit(workspace);
  if (restored !== expectedHead) {
    throw new Error(`could not restore Git HEAD after role invocation (expected ${expectedHead}, observed ${restored ?? "none"})`);
  }
  return true;
}

/** Restore only the configured product boundary to a historical tree, leaving `.hoh` untouched. */
async function restoreArtifactAtCommit(workspace: string, artifactDir: string, commitOid: string): Promise<void> {
  const pathspec = artifactDir === "." ? [".", ":(exclude).hoh"] : [`:(top,literal)${artifactDir}`];
  // ls-tree does not support exclude pathspec magic on all supported Git
  // versions, so enumerate names and apply the canonical artifact boundary in
  // process before any mutation.
  const sourceResult = await git(["ls-tree", "-r", "--name-only", "-z", commitOid], workspace);
  const currentResult = await git(["ls-files", "-z"], workspace);
  const withinArtifact = (relativePath: string) =>
    !isRuntimePath(relativePath) &&
    (artifactDir === "." || relativePath === artifactDir || relativePath.startsWith(`${artifactDir}/`));
  const sourcePaths = new Set(sourceResult.stdout.split("\0").filter(withinArtifact));
  const currentPaths = currentResult.stdout.split("\0").filter(withinArtifact);

  // Exact A0 semantics include ignored and ordinary untracked product files.
  await git(["clean", "-fdxq", "--", ...pathspec], workspace);
  for (const relativePath of currentPaths) {
    if (sourcePaths.has(relativePath)) continue;
    await git(["rm", "-fq", "--", `:(top,literal)${relativePath}`], workspace);
  }
  for (const relativePath of sourcePaths) {
    await git(["checkout", "-q", commitOid, "--", `:(top,literal)${relativePath}`], workspace);
  }
}

function isRuntimePath(relativePath: string): boolean {
  return relativePath === ".hoh" || relativePath.startsWith(".hoh/");
}

function oneLine(s: string, max = 96): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
