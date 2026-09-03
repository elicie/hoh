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
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Harness, RoleInvocation, RoleResult } from "../harness/types.js";
import { CODING_TOOLS, INSPECT_TOOLS, READ_ONLY_TOOLS, emptyUsage } from "../harness/types.js";
import type {
  CheckResult,
  ClaimCatalog,
  ClaimRecord,
  CoverageState,
  DeveloperRecord,
  EvidenceBundle,
  EvidenceSubmission,
  Ledger,
  PlannerOverlay,
  PlannerRecord,
  QaStatus,
  RoleUsage,
  RunConfig,
} from "../types.js";
import { EXECUTION_EVIDENCE_TYPES } from "../types.js";
import { runCheck, runChecks } from "./checks.js";
import { buildCandidateDiff } from "./candidate-diff.js";
import { ensureClaimState } from "./claims.js";
import { assertValidConfig, type ConfigPatch, DEFAULT_CONFIG, type HohConfig, mergeConfig, modelForRole } from "./config.js";
import { claimCatalogSha256, rebuildCoverage } from "./coverage.js";
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
import { renderDevelopmentDocument, renderDeveloperPrompts, renderPlannerPrompts, renderTesterPrompts } from "./prompts.js";
import { assertProtocolReceiptIntegrity, buildProtocolReceipt, hasExplicitProtocol } from "./protocol.js";
import { renderRunReadme, renderTesterReport } from "./report.js";
import { plannerTools, SUBMIT_EVIDENCE_TOOL, SUBMIT_PLAN_TOOL, testerTools } from "./schemas.js";
import { lastCompletedLoop, loadLedger, loadRun, pad, readJson, RunPaths, writeJson, writeText } from "./state.js";

export type Logger = (message: string) => void;

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
}

export async function runHoh(opts: RunOptions): Promise<RunResult> {
  const ws = path.resolve(opts.workspace);
  await mkdir(ws, { recursive: true });
  const paths = new RunPaths(ws);
  const log = opts.log ?? (() => {});
  await ensureRepo(ws);

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

  let run = await loadRun(paths);
  let initialized = false;
  if (!run) {
    if (!opts.specPath) throw new Error("A specification file (--spec) is required to start a new run.");
    const protocolReceipt = await buildProtocolReceipt(config, opts.harness, { legacyDefault: protocolImplicit, origin: "run_start" });
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
    await writeJson(paths.ledger, emptyLedger());
    initialized = true;
  } else {
    let protocolReceipt = run.protocol_receipt;
    if (protocolReceipt) {
      assertProtocolReceiptIntegrity(protocolReceipt);
    } else {
      const recordedLegacy = !hasExplicitProtocol(run.config);
      const recordedConfig = mergeConfig(DEFAULT_CONFIG, run.config as ConfigPatch);
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
    if (protocolReceipt.mode === "paper") {
      const requestedReceipt = await buildProtocolReceipt(config, opts.harness, {
        legacyDefault: protocolReceipt.legacy_default,
        origin: protocolReceipt.origin,
      });
      if (requestedReceipt.protocol_sha256 !== protocolReceipt.protocol_sha256) {
        throw new Error(
          `cannot resume paper run ${run.run_id}: protocol contract changed (${protocolReceipt.protocol_sha256.slice(0, 12)} -> ${requestedReceipt.protocol_sha256.slice(0, 12)}); start a new run in another workspace`,
        );
      }
    }
    const changed = JSON.stringify(run.config) !== JSON.stringify(config);
    run.config = config;
    run.config_source = configSource;
    run.protocol_receipt = protocolReceipt;
    await writeJson(paths.config, config);
    await writeJson(paths.runJson, run);
    if (changed) {
      await commitAll(ws, `chore(hoh): update configuration (${configSource})`, RUNTIME_IDENTITY, [paths.rel(paths.config), paths.rel(paths.runJson)]);
    }
    log(`resuming run ${run.run_id}${changed ? " with updated configuration" : ""}`);
  }
  const spec = await readFile(paths.spec, "utf8");
  const claimState = await ensureClaimState({
    workspace: ws,
    specPath: run.spec_path,
    spec,
    harness: opts.harness,
    paths,
    model: modelForRole(config, "planner"),
    expectedModel: run.protocol_receipt?.mode === "paper" ? run.protocol_receipt.models.planner ?? undefined : undefined,
    timeoutMs: config.timeouts.role_min * 60_000,
  });
  await writeText(paths.readme, await renderRunReadme(paths, run, await loadLedger(paths)));
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

  const ctx: Ctx = { ws, paths, run, config, harness: opts.harness, log, claimCatalog: claimState.catalog, coverage: claimState.coverage };
  const done = await lastCompletedLoop(paths);
  const results: LoopResult[] = [];
  for (let t = done + 1; t <= config.loops; t++) {
    results.push(await runLoop(ctx, t));
  }
  if (done >= config.loops) log(`all ${config.loops} loops already completed; nothing to do`);
  return { run, results, ledger: await loadLedger(paths) };
}

// ---------------------------------------------------------------------------

export async function runLoop(ctx: Ctx, t: number): Promise<LoopResult> {
  const { ws, paths, run, config, log } = ctx;
  const tag = `[loop ${pad(t)}]`;
  const roleTimeoutMs = config.timeouts.role_min * 60_000;
  const loopDir = paths.loopDir(t);
  await mkdir(path.join(loopDir, "transcripts"), { recursive: true });

  try {
    const spec = await readFile(paths.spec, "utf8");
    const artifactDir = config.artifact_dir;
    const artifactAbs = path.resolve(ws, artifactDir);
    await mkdir(artifactAbs, { recursive: true });
    const ledger = await loadLedger(paths);
    const previousEvidence = t > 1 ? await readJson<EvidenceBundle>(paths.evidenceJson(t - 1)) : null;
    const previousDeveloper = t > 1 ? await readJson<DeveloperRecord>(paths.developerJson(t - 1)) : null;
    const previousChecks = previousEvidence?.checks ?? null;
    const baseCommit = await headCommit(ws);
    // A run may start from a provided artifact (warm start at loop 1): identify it like any other candidate.
    const initialTree = t === 1 ? await artifactTreeHash(ws, { subdir: artifactDir }) : null;
    const baseCandidateId =
      previousDeveloper?.candidate_id ?? (initialTree && initialTree !== EMPTY_TREE ? `loop-00-${initialTree.slice(0, 12)}` : null);

    process.env.HOH_LOOP = String(t);

    // ------------------------------------------------------------- PLAN (D_t)
    let planner = await readJson<PlannerRecord>(paths.plannerJson(t));
    let developmentDocument = planner ? await readFile(paths.developmentDocument(t), "utf8").catch(() => null) : null;
    let overlay: PlannerOverlay;
    if (planner && developmentDocument) {
      overlay = planner;
      log(`${tag} planner: reusing recorded development document (resume)`);
    } else {
    process.env.HOH_ROLE = "planner";
    log(`${tag} planner: start (base ${baseCandidateId ?? "none"})`);
    const plannerPrompts = await renderPlannerPrompts({
      loopIndex: t,
      cwd: ws,
      artifactDir,
      specPath: run.spec_path,
      spec,
      baseCandidateId,
      previousEvidence,
      previousChecks,
      ledger,
      claimCatalog: ctx.claimCatalog,
      coverage: ctx.coverage,
    });
    const plannerRun = await invokeRole(
      ctx,
      {
        role: "planner",
        loopIndex: t,
        cwd: ws,
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
    const validated = validateOverlay(lastSubmission<PlannerOverlay>(plannerRun.result, SUBMIT_PLAN_TOOL) ?? parseJsonBlock<PlannerOverlay>(plannerRun.result.finalText));
    if (!validated) {
      throw new Error(`planner returned no development document after ${plannerRun.attempts} attempt(s)`);
    }
    overlay = validated;
    // The planner is read-only by tool allowlist; still assert nothing changed.
    const artifactSpec = [".", ":(exclude).hoh"];
    const plannerChanges = await pathsChanged(ws, artifactSpec);
    if (plannerChanges.length) {
      log(`${tag} planner: WARNING workspace changed during planning (${plannerChanges.length} paths); reverting`);
      await restorePaths(ws, artifactSpec);
    }
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
      previousEvidence,
      ledger,
      previousChecks,
    });
    await writeJson(paths.plannerJson(t), planner);
    await writeText(paths.developmentDocument(t), developmentDocument);
    await commitAll(ws, `docs(loop-${pad(t)}): ${oneLine(overlay.objective)}`, ROLE_IDENTITY.planner, [".hoh"]);
    log(`${tag} planner: done — ${oneLine(overlay.objective)}`);
    }

    // ---------------------------------------------------------- DEVELOP (A_t)
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
    const preDevelopmentCommit = await headCommit(ws);
    if (!preDevelopmentCommit) throw new Error(`cannot start Developer for loop ${t}: workspace has no base commit`);
    const recordSpec = [".hoh", `:(exclude).hoh/iterations/loop-${pad(t)}/transcripts`];
    // Anything already dirty under .hoh before the developer starts belongs to the runtime, not to the developer.
    const dirtyBefore = new Set(await pathsChanged(ws, recordSpec));
    log(`${tag} developer: start`);
    const developerPrompts = await renderDeveloperPrompts({
      loopIndex: t,
      cwd: ws,
      artifactDir,
      specPath: run.spec_path,
      spec,
      devDocPath: paths.rel(paths.developmentDocument(t)),
      developmentDocument,
      baseCandidateId,
      previousChangedPaths: previousDeveloper?.changed_paths ?? [],
      previousChecks,
    });
    const developerRun = await invokeRole(ctx, {
      role: "developer",
      loopIndex: t,
      cwd: ws,
      systemPrompt: developerPrompts.system,
      prompt: developerPrompts.user,
      tools: CODING_TOOLS,
      structuredTools: [],
      transcriptPath: paths.transcript(t, "developer"),
      timeoutMs: roleTimeoutMs,
      model: modelForRole(config, "developer"),
    });
    const violations: string[] = [];
    // Runtime records are off limits to the Developer; the runtime's own transcript for this loop is not a violation.
    const hohChanges = (await pathsChanged(ws, recordSpec)).filter((p) => !dirtyBefore.has(p));
    if (hohChanges.length) {
      violations.push(...hohChanges.map((p) => `modified runtime record ${p} (reverted)`));
      await restorePaths(ws, hohChanges.map((p) => `:(literal)${p}`));
      log(`${tag} developer: WARNING reverted ${hohChanges.length} change(s) under .hoh/`);
    }
    const commit = await commitAll(ws, `feat(loop-${pad(t)}): ${oneLine(overlay.objective)}`, ROLE_IDENTITY.developer, ["."]);
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
      commit,
      changed_paths: commit ? (await changedPaths(ws, preDevelopmentCommit, commit)).filter((p) => !p.startsWith(".hoh/")) : [],
      summary: developerRun.result.finalText,
      violations,
      usage: developerRun.usage,
      created_at: new Date().toISOString(),
    };
    await writeJson(paths.developerJson(t), developer);
    log(`${tag} developer: done — candidate ${newCandidateId}, ${developer.changed_paths.length} path(s) changed${commit ? "" : " (no commit)"}`);
    }
    const candidateId = developer.candidate_id;
    const commitRange = await resolveDeveloperCommitRange(ws, developer);

    // ------------------------------------------------- CHECK + TEST (E_t)
    process.env.HOH_ROLE = "tester";
    const wt = await mkdtemp(path.join(os.tmpdir(), `hoh-${run.run_id}-loop-${pad(t)}-`));
    const evidenceDir = paths.evidenceDir(t);
    await prepareEvidenceDirectory(evidenceDir);
    let evidence: EvidenceBundle;
    let evidenceBound = false;
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
          ),
        );
      }
      checks.push(...(await runChecks(config.checks, wtArtifact, config.timeouts.check_min * 60_000, checkEnv)));
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
        [paths.rel(paths.developerJson(t)), paths.rel(paths.transcript(t, "developer")), paths.rel(paths.checksJson(t)), paths.rel(evidenceDir)],
      );

      log(`${tag} tester: start`);
      const testerPrompts = await renderTesterPrompts({
        loopIndex: t,
        cwd: wt,
        artifactDir,
        spec,
        candidateId,
        baseCandidateId,
        candidateDiff,
        developerSummary: developer.summary,
        developmentDocument,
        checks,
        ledger,
        claimCatalog: ctx.claimCatalog,
        coverage: ctx.coverage,
      });
      const testerRun = await invokeRole(
        ctx,
        {
          role: "tester",
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
      const after = await artifactTreeHash(wt, { subdir: artifactDir });
      // The Tester works in the worktree, but bash could still reach the main workspace by absolute path.
      const testerGuardSpec = [".", ":(exclude).hoh"];
      const testerWorkspaceChanges = await pathsChanged(ws, testerGuardSpec);
      if (testerWorkspaceChanges.length) {
        log(`${tag} tester: WARNING main workspace changed during QA (${testerWorkspaceChanges.length} paths); reverting`);
        await restorePaths(ws, testerGuardSpec);
      }
      const evidenceRel = paths.rel(evidenceDir).replaceAll(path.sep, "/");
      const immutableCheckRel = `${evidenceRel}/checks/`;
      const testerTranscriptRel = paths.rel(paths.transcript(t, "tester")).replaceAll(path.sep, "/");
      const testerRuntimeChanges = (await pathsChanged(ws, [".hoh"], { includeIgnored: true })).filter((changed) => {
        const rel = changed.replaceAll(path.sep, "/");
        if (rel === testerTranscriptRel) return false;
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
      const submission =
        lastSubmission<EvidenceSubmission>(testerRun.result, SUBMIT_EVIDENCE_TOOL) ?? parseJsonBlock<EvidenceSubmission>(testerRun.result.finalText);
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
      );
      evidenceBound = true;
    } finally {
      try {
        if (!evidenceBound) {
          const notes = await sanitizeEvidenceDirectory(evidenceDir);
          for (const note of notes) log(`${tag} runtime: ${note}`);
        }
      } finally {
        await worktreeRemove(ws, wt);
        delete process.env.HOH_CANDIDATE_DIR;
        delete process.env.HOH_EVIDENCE_DIR;
      }
    }

    const delta = applyEvidence(ledger, evidence);
    await rm(paths.errorJson(t), { force: true }); // a previous failed attempt of this loop is superseded
    await writeJson(paths.ledger, ledger);
    await writeJson(paths.checksJson(t), evidence.checks);
    await writeJson(paths.evidenceJson(t), evidence);
    ctx.coverage = await rebuildCoverage(paths, ctx.claimCatalog);
    await writeJson(paths.coverage, ctx.coverage);
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
    const message = err?.stack ?? String(err);
    await writeJson(paths.errorJson(t), { loop_index: t, message: err?.message ?? String(err), stack: message, at: new Date().toISOString() });
    await writeText(paths.readme, await renderRunReadme(paths, run, await loadLedger(paths)));
    await commitAll(ws, `chore(loop-${pad(t)}): runtime error`, RUNTIME_IDENTITY, [".hoh"]);
    log(`${tag} ERROR ${err?.message ?? err}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Role invocation with structured-output retry
// ---------------------------------------------------------------------------

interface InvokeOutcome {
  result: RoleResult;
  attempts: number;
  usage: RoleUsage;
}

async function invokeRole(ctx: Ctx, inv: RoleInvocation, requiredTool?: string): Promise<InvokeOutcome> {
  const started = Date.now();
  const total: RoleUsage = { ...emptyUsage(), turns: 0, duration_ms: 0 };
  let attempts = 0;
  let result: RoleResult = { finalText: "", submissions: {}, usage: emptyUsage(), turns: 0 };
  const maxAttempts = requiredTool ? 2 : 1;
  while (attempts < maxAttempts) {
    attempts += 1;
    const prompt =
      attempts === 1
        ? inv.prompt
        : `${inv.prompt}\n\n## Runtime notice\n\nYour previous attempt ended without calling \`${requiredTool}\`. The runtime only accepts output delivered through that tool. Redo the work as needed and call \`${requiredTool}\` exactly once before finishing.`;
    result = await ctx.harness.invoke({ ...inv, prompt });
    if (ctx.run.protocol_receipt?.mode === "paper") {
      const expected = ctx.run.protocol_receipt.models[inv.role];
      if (!expected || result.model !== expected) {
        throw new Error(
          `paper protocol model mismatch for ${inv.role}: expected ${expected ?? "(none)"}, harness reported ${result.model ?? "(none)"}`,
        );
      }
    }
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const) total[k] += result.usage[k] ?? 0;
    total.turns += result.turns;
    if (result.model) total.model = result.model;
    if (!requiredTool || (result.submissions[requiredTool]?.length ?? 0) > 0 || parseJsonBlock(result.finalText)) break;
    ctx.log(`[loop ${pad(inv.loopIndex)}] ${inv.role}: no ${requiredTool} call; retrying (${attempts}/${maxAttempts})`);
  }
  total.duration_ms = Date.now() - started;
  return { result, attempts, usage: total };
}

function lastSubmission<T>(result: RoleResult, tool: string): T | null {
  const list = result.submissions[tool];
  return list && list.length ? (list[list.length - 1] as T) : null;
}

/** Fallback for harnesses without tool support: a fenced ```json block in the final text. */
export function parseJsonBlock<T>(text: string): T | null {
  const m = /```json\s*([\s\S]*?)```/i.exec(text ?? "");
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as T;
  } catch {
    return null;
  }
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
// Evidence normalization (paper appendix A.4)
// ---------------------------------------------------------------------------

interface NormalizeInput {
  submission: EvidenceSubmission | null;
  loopIndex: number;
  candidateId: string;
  checks: CheckResult[];
  before: string;
  after: string;
  finalText: string;
  usage: RoleUsage;
  attempts: number;
  /** paths in the main workspace touched during QA (reverted by the runtime) */
  workspaceViolations?: string[];
  claimCatalog?: ClaimCatalog;
  /** Recorded candidate tree before checks; any post-check mismatch invalidates QA. */
  expectedCandidateSha?: string;
}

export function normalizeEvidence(input: NormalizeInput): EvidenceBundle {
  const executionEvidenceTypes = new Set<string>(EXECUTION_EVIDENCE_TYPES);
  const fixedClaims = new Map(input.claimCatalog?.claims.map((claim) => [claim.id, claim]) ?? []);
  const notes: string[] = [];
  const frozen = input.before === input.after;
  let sub = input.submission;
  if (!sub || typeof sub !== "object") {
    notes.push(`tester returned no structured evidence after ${input.attempts} attempt(s); recorded as a gap`);
    sub = {
      qa_status: "fail",
      summary: "QA Tester did not deliver structured evidence.",
      verified_records: [],
      gap_records: [
        {
          claim_id: "tester.no_structured_output",
          claim: "The QA Tester must deliver evidence through submit_evidence.",
          execution_records: [{ type: "log", path: "tester.final_text", observation: (input.finalText || "(no output)").slice(0, 2000) }],
          severity: "major",
          recommended_update: "Re-run QA; make behaviors easier to observe so the tester can cite records.",
        },
      ],
      planner_handoff: { preservation_constraints: [], update_targets: ["Obtain structured QA evidence for the candidate"], validation_requirements: [] },
    };
  }

  const toRecords = (list: unknown, status: ClaimRecord["status"]): ClaimRecord[] =>
    (Array.isArray(list) ? list : [])
      .filter((r) => r && typeof r === "object" && typeof (r as any).claim_id === "string")
      .map((r: any) => ({
        claim_id: String(r.claim_id).trim(),
        claim: String(r.claim ?? "").trim(),
        execution_records: (Array.isArray(r.execution_records) ? r.execution_records : []).map((x: any) => ({
          type: String(x?.type ?? "other"),
          path: x?.path ? String(x.path) : undefined,
          observation: String(x?.observation ?? ""),
        })),
        status,
        severity: r.severity,
        player_impact: r.player_impact,
        recommended_update: r.recommended_update,
      }));

  const gaps = toRecords(sub.gap_records, "gap");
  const gapIds = new Set(gaps.map((g) => g.claim_id));
  // A claim cannot be both verified and a gap: the gap wins.
  const verifiedCandidates = toRecords(sub.verified_records, "verified").filter((v) => {
    if (gapIds.has(v.claim_id)) {
      notes.push(`claim ${v.claim_id} was listed as both verified and gap; kept as gap`);
      return false;
    }
    return true;
  });
  const verified: ClaimRecord[] = [];
  for (const record of verifiedCandidates) {
    const observedTypes = new Set(record.execution_records.map((e) => e.type));
    if (!record.execution_records.some((e) => executionEvidenceTypes.has(e.type))) {
      gaps.push({ ...record, status: "gap", severity: "minor" });
      gapIds.add(record.claim_id);
      notes.push(`claim ${record.claim_id}: source-only evidence downgraded to gap`);
      continue;
    }
    const missing = (fixedClaims.get(record.claim_id)?.requires ?? []).filter((type) => !observedTypes.has(type));
    if (missing.length) {
      gaps.push({ ...record, status: "gap", severity: "minor" });
      gapIds.add(record.claim_id);
      notes.push(`claim ${record.claim_id}: missing required evidence types: ${missing.join(", ")}`);
      continue;
    }
    verified.push(record);
  }

  for (const c of input.checks) {
    if (c.status === "pass") continue;
    const id = `check.${c.name}`;
    const outputPath = c.stderr_tail ? c.stderr_path : c.stdout_path;
    const outputSha256 = c.stderr_tail ? c.stderr_sha256 : c.stdout_sha256;
    const executionRecord = {
      type: "check",
      path: outputPath ?? c.name,
      ...(outputSha256 ? { sha256: outputSha256 } : {}),
      observation: `${c.status}, exit ${c.exit_code ?? "-"}: ${(c.stderr_tail || c.stdout_tail).trim().slice(-500)}`,
    };
    const recommendedUpdate = `Make "${c.command}" succeed on the artifact.`;
    const existingGap = gaps.find((gap) => gap.claim_id === id);
    if (existingGap) {
      if (!existingGap.execution_records.some((record) => record.type === "check" && record.path === executionRecord.path)) {
        existingGap.execution_records.push(executionRecord);
      }
      existingGap.severity = "blocker";
      existingGap.recommended_update = recommendedUpdate;
      notes.push(`claim ${id}: deterministic check failure enforced as blocker`);
    } else {
      gaps.push({
        claim_id: id,
        claim: `Deterministic check "${c.name}" passes (${c.command}).`,
        execution_records: [executionRecord],
        status: "gap",
        severity: "blocker",
        recommended_update: recommendedUpdate,
      });
      gapIds.add(id);
    }
  }
  if (!frozen) {
    notes.push(`candidate mutated during QA (tree ${input.before.slice(0, 12)} → ${input.after.slice(0, 12)}); observations are not bound to the candidate`);
    gaps.push({
      claim_id: "runtime.candidate_mutated",
      claim: "The QA Tester leaves the frozen candidate unmodified.",
      execution_records: [{ type: "runtime_trace", observation: `artifact tree changed during QA: ${input.before} → ${input.after}` }],
      status: "gap",
      severity: "blocker",
      recommended_update: "QA must only build, run, and inspect; it must not edit files.",
    });
  }

  if (input.expectedCandidateSha && input.before !== input.expectedCandidateSha) {
    notes.push(
      `candidate mutated during deterministic checks (tree ${input.expectedCandidateSha.slice(0, 12)} → ${input.before.slice(0, 12)})`,
    );
    gaps.push({
      claim_id: "runtime.candidate_mutated_by_checks",
      claim: "Deterministic checks leave the frozen candidate source tree unchanged.",
      execution_records: [
        {
          type: "runtime_trace",
          observation: `artifact tree changed during checks: ${input.expectedCandidateSha} → ${input.before}`,
        },
      ],
      status: "gap",
      severity: "blocker",
      recommended_update: "Checks and worktree_setup must not modify tracked candidate source files.",
    });
  }

  if (input.workspaceViolations?.length) {
    notes.push(`tester modified the main workspace (${input.workspaceViolations.slice(0, 10).join(", ")}); changes were reverted`);
    gaps.push({
      claim_id: "runtime.workspace_mutated_by_tester",
      claim: "The QA Tester does not modify the development workspace.",
      execution_records: [{ type: "runtime_trace", observation: `reverted: ${input.workspaceViolations.slice(0, 20).join(", ")}` }],
      status: "gap",
      severity: "blocker",
      recommended_update: "QA must only build, run, and inspect the isolated candidate copy.",
    });
  }

  const finalGapIds = new Set(gaps.map((gap) => gap.claim_id));
  const resolvedVerified = verified.filter((record) => {
    if (!finalGapIds.has(record.claim_id)) return true;
    notes.push(`claim ${record.claim_id} conflicted with a runtime gap; kept as gap`);
    return false;
  });

  let qa_status: QaStatus;
  if (!frozen || gaps.some((g) => g.severity === "blocker") || resolvedVerified.length === 0) qa_status = "fail";
  else if (gaps.length > 0) qa_status = "partial";
  else qa_status = "pass";

  const handoff = sub.planner_handoff && typeof sub.planner_handoff === "object" ? sub.planner_handoff : ({} as any);
  return {
    schema_version: 1,
    loop_index: input.loopIndex,
    candidate_id: input.candidateId,
    claim_catalog_sha256: input.claimCatalog ? claimCatalogSha256(input.claimCatalog) : null,
    qa_status,
    summary: String(sub.summary ?? "").trim(),
    verified_records: resolvedVerified,
    gap_records: gaps,
    planner_handoff: {
      preservation_constraints: strList(handoff.preservation_constraints),
      update_targets: strList(handoff.update_targets),
      validation_requirements: strList(handoff.validation_requirements),
    },
    checks: input.checks,
    candidate_source_sha256_before: input.before,
    candidate_source_sha256_after: input.after,
    frozen,
    runtime_notes: notes,
    usage: input.usage,
    created_at: new Date().toISOString(),
  };
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

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

function oneLine(s: string, max = 96): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
