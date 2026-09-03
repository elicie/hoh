import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { MockHarness } from "../harness/mock.js";
import {
  buildExperimentProtocolReceipt,
  EXPERIMENT_CONDITION_RECORD,
  EXPERIMENT_CONDITION_POLICY_VERSION,
  parseExperimentConditionRecord,
  runExperimentCondition,
  type ExperimentConditionRecord,
} from "../experiment/conditions.js";
import { EXPERIMENT_CONDITIONS, type ExperimentCondition } from "../experiment/manifest.js";
import { DEFAULT_CONFIG, mergeConfig } from "../runtime/config.js";
import { git } from "../runtime/git.js";
import { canonicalSha256 } from "../runtime/protocol.js";
import { verifyCurrentRunReceipt } from "../runtime/run-receipt.js";
import { readJson, RunPaths } from "../runtime/state.js";
import type { BudgetLedger, DeveloperRecord, EvidenceSubmission } from "../types.js";
import { makeWorkspace } from "./helpers.js";

const PLAN_SHA256 = "a".repeat(64);
const EVALUATOR_SENTINEL = "PRIVATE_EVALUATOR_RUBRIC_DO_NOT_LEAK_9c82";
const EVIDENCE_SENTINEL = "PRIOR_QA_EVIDENCE_SENTINEL_71ad";

interface HarnessObservations {
  developerInputs: string[];
  developerPriorRuntimeReadable: Array<boolean | null>;
  developerGitHistoryLines: number[];
  plannerGitHistoryLines: number[];
  plannerGitPointerReadable: boolean[];
  plannerPriorEvidenceInGit: Array<boolean | null>;
  plannerPriorEvidenceReadable: Array<boolean | null>;
  roleInputs: string[];
}

interface ConditionFixture {
  condition: ExperimentCondition;
  ws: string;
  cleanup: () => Promise<void>;
  paths: RunPaths;
  harness: MockHarness;
  observations: HarnessObservations;
  result: Awaited<ReturnType<typeof runExperimentCondition>>;
  record: ExperimentConditionRecord;
}

function emptyObservations(): HarnessObservations {
  return {
    developerInputs: [],
    developerPriorRuntimeReadable: [],
    developerGitHistoryLines: [],
    plannerGitHistoryLines: [],
    plannerGitPointerReadable: [],
    plannerPriorEvidenceInGit: [],
    plannerPriorEvidenceReadable: [],
    roleInputs: [],
  };
}

function createConditionHarness(observations: HarnessObservations, options: { commitHead?: boolean } = {}): MockHarness {
  return new MockHarness({
    planner: async (inv, api) => {
      observations.roleInputs.push(`${inv.systemPrompt}\n${inv.prompt}`);
      observations.plannerGitHistoryLines.push(
        (await git(["log", "--format=%H"], inv.cwd, { allowFail: true })).stdout.split("\n").filter(Boolean).length,
      );
      observations.plannerGitPointerReadable.push((await api.read(".git")) !== null);
      const prior =
        inv.loopIndex === 1
          ? null
          : (await api.read(`.hoh/iterations/loop-${String(inv.loopIndex - 1).padStart(2, "0")}/evidence.json`)) !== null;
      observations.plannerPriorEvidenceReadable.push(prior);
      observations.plannerPriorEvidenceInGit.push(
        inv.loopIndex === 1
          ? null
          : (
              await git(
                ["show", `HEAD:.hoh/iterations/loop-${String(inv.loopIndex - 1).padStart(2, "0")}/evidence.json`],
                inv.cwd,
                { allowFail: true },
              )
            ).code === 0,
      );
      api.submit("submit_development_document", {
        objective: `objective-${inv.loopIndex}`,
        priorities: [
          {
            name: `iteration-${inv.loopIndex}`,
            action: `improve artifact in iteration ${inv.loopIndex}`,
            observable_outcome: `artifact contains dev-${inv.loopIndex}`,
          },
        ],
        preservation_gate: [],
        acceptance_gate: ["artifact remains readable"],
      });
      return `planned ${inv.loopIndex}`;
    },
    developer: async (inv, api) => {
      observations.roleInputs.push(`${inv.systemPrompt}\n${inv.prompt}`);
      const before = (await api.read("artifact.txt")) ?? "";
      observations.developerInputs.push(before);
      observations.developerPriorRuntimeReadable.push(
        inv.loopIndex === 1
          ? null
          : (await api.read(`.hoh/iterations/loop-${String(inv.loopIndex - 1).padStart(2, "0")}/developer.json`)) !== null,
      );
      observations.developerGitHistoryLines.push(
        ((await api.read(".git/logs/HEAD")) ?? "")
          .split("\n")
          .filter(Boolean).length,
      );
      await api.write("artifact.txt", `${before}dev-${inv.loopIndex}\n`);
      if (options.commitHead) {
        await api.write(".hoh/role-owned.json", "untrusted runtime record\n");
        await git(["add", "-A", "--", "."], inv.cwd);
        await git(
          ["-c", "user.name=role", "-c", "user.email=role@example.invalid", "commit", "-q", "--no-verify", "-m", "role-owned head"],
          inv.cwd,
        );
      }
      return `developed ${inv.loopIndex}`;
    },
    tester: async (inv, api) => {
      observations.roleInputs.push(`${inv.systemPrompt}\n${inv.prompt}`);
      const submission: EvidenceSubmission = {
        qa_status: "pass",
        summary: `${EVIDENCE_SENTINEL}-${inv.loopIndex}`,
        verified_records: [
          {
            claim_id: `free.iteration.${inv.loopIndex}`,
            claim: `iteration ${inv.loopIndex} artifact is readable`,
            execution_records: [{ type: "run", observation: `observed dev-${inv.loopIndex}` }],
          },
        ],
        gap_records: [],
        planner_handoff: {
          preservation_constraints: ["preserve the readable artifact"],
          update_targets: [`${EVIDENCE_SENTINEL}-target-${inv.loopIndex}`],
          validation_requirements: ["read artifact.txt"],
        },
      };
      api.submit("submit_evidence", submission);
      return `tested ${inv.loopIndex}`;
    },
  });
}

async function runFixture(condition: ExperimentCondition): Promise<ConditionFixture> {
  const { ws, spec, cleanup } = await makeWorkspace();
  await writeFile(path.join(ws, "artifact.txt"), "A0\n");
  const observations = emptyObservations();
  const harness = createConditionHarness(observations);
  const request = {
    condition,
    workspace: ws,
    specPath: spec,
    harness,
    config: {
      protocol: "paper" as const,
      harness: "mock" as const,
      loops: 2,
      models: { default: "shared-model" },
      checks: [],
      budgets: { run: { total_tokens: 1000 } },
    },
    binding: { plan_sha256: PLAN_SHA256, attempt_id: `attempt-${condition}`, cell_id: `cell-${condition}` },
    // Unknown caller metadata must never be serialized or forwarded to roles.
    evaluator_secret: EVALUATOR_SENTINEL,
  };
  const result = await runExperimentCondition(request);
  const paths = new RunPaths(ws);
  const record = (await readJson<ExperimentConditionRecord>(path.join(ws, EXPERIMENT_CONDITION_RECORD)))!;
  return { condition, ws, cleanup, paths, harness, observations, result, record };
}

test("experiment conditions enforce five distinct execution contracts and bind verified receipts", async () => {
  const fixtures: ConditionFixture[] = [];
  try {
    for (const condition of EXPERIMENT_CONDITIONS) fixtures.push(await runFixture(condition));

    for (const fixture of fixtures) {
      const { condition, result, record, paths, ws, observations } = fixture;
      assert.equal(result.condition, condition);
      assert.equal(result.status, "completed");
      assert.deepEqual(result.binding, {
        plan_sha256: PLAN_SHA256,
        attempt_id: `attempt-${condition}`,
        cell_id: `cell-${condition}`,
      });
      assert.equal(record.policy_version, EXPERIMENT_CONDITION_POLICY_VERSION);
      const { condition_contract_sha256: _hash, ...payload } = record;
      assert.equal(record.condition_contract_sha256, canonicalSha256(payload));
      assert.deepEqual(parseExperimentConditionRecord(record), record);
      assert.throws(
        () => parseExperimentConditionRecord({ ...record, evaluator: EVALUATOR_SENTINEL }),
        /must contain exactly/,
      );
      assert.throws(
        () => parseExperimentConditionRecord({ ...record, condition_contract_sha256: "f".repeat(64) }),
        /failed its integrity check/,
      );
      assert.equal(result.condition_contract_sha256, record.condition_contract_sha256);
      assert.match(result.protocol_receipt_sha256 ?? "", /^[0-9a-f]{64}$/);
      assert.equal(record.common.protocol_sha256, result.protocol_receipt_sha256);
      assert.equal(result.run_receipt_sha256, result.run_receipt.receipt_sha256);
      assert.deepEqual(result.final_artifact, result.run_receipt.candidate);
      assert.deepEqual(record.common.harness, { name: "mock", version: "builtin-1" });
      assert.deepEqual(record.common.models, {
        planner: "mock:shared-model",
        developer: "mock:shared-model",
        tester: "mock:shared-model",
      });
      assert.match(record.a0.workspace_tree_oid, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
      assert.ok(
        result.run_receipt.artifacts.some((artifact) => artifact.path === EXPERIMENT_CONDITION_RECORD),
        `${condition} receipt must hash its condition contract`,
      );
      assert.equal((await verifyCurrentRunReceipt(ws)).ok, true);
      assert.ok(observations.roleInputs.every((input) => !input.includes(EVALUATOR_SENTINEL)), `${condition} role input leaked evaluator metadata`);
      assert.ok(!(await readAllRuntimeText(paths.root)).includes(EVALUATOR_SENTINEL), `${condition} runtime record leaked evaluator metadata`);
    }

    const byCondition = Object.fromEntries(fixtures.map((fixture) => [fixture.condition, fixture])) as Record<ExperimentCondition, ConditionFixture>;
    const protocolConfig = mergeConfig(DEFAULT_CONFIG, {
      protocol: "paper",
      harness: "mock",
      loops: 2,
      models: { default: "shared-model" },
      checks: [],
      budgets: { run: { total_tokens: 1000 } },
    });
    const hohProtocol = await buildExperimentProtocolReceipt(protocolConfig, byCondition.hoh.harness, "hoh");
    const vanillaProtocol = await buildExperimentProtocolReceipt(protocolConfig, byCondition.vanilla.harness, "vanilla");
    assert.equal(hohProtocol.protocol_sha256, byCondition.hoh.record.common.protocol_sha256);
    assert.equal(vanillaProtocol.protocol_sha256, byCondition.vanilla.record.common.protocol_sha256);
    assert.notEqual(vanillaProtocol.protocol_sha256, hohProtocol.protocol_sha256);
    assert.deepEqual(vanillaProtocol.models, hohProtocol.models);
    assert.deepEqual(vanillaProtocol.harness, hohProtocol.harness);

    assert.deepEqual(roleOrder(byCondition.hoh), ["planner", "developer", "tester", "planner", "developer", "tester"]);
    assert.deepEqual(roleOrder(byCondition["no-evidence"]), ["planner", "developer", "tester", "planner", "developer", "tester"]);
    assert.deepEqual(roleOrder(byCondition["no-warm-start"]), ["planner", "developer", "tester", "planner", "developer", "tester"]);
    assert.deepEqual(roleOrder(byCondition["no-plan-update"]), ["planner", "developer", "tester", "developer", "tester"]);
    assert.deepEqual(roleOrder(byCondition.vanilla), ["developer", "developer"]);

    const fixedPlan = byCondition["no-plan-update"];
    assert.deepEqual(
      await readFile(fixedPlan.paths.developmentDocument(2)),
      await readFile(fixedPlan.paths.developmentDocument(1)),
      "no-plan-update must reuse D1 byte-for-byte",
    );
    assert.equal(await exists(fixedPlan.paths.plannerJson(2)), false, "no-plan-update must not fabricate a later Planner record");
    const fixedPlanBudget = (await readJson<BudgetLedger>(fixedPlan.paths.budget))!;
    assert.deepEqual(
      fixedPlanBudget.attempts.map((attempt) => attempt.role),
      ["planner", "developer", "tester", "developer", "tester"],
    );

    const noEvidence = byCondition["no-evidence"];
    const hoh = byCondition.hoh;
    assert.deepEqual(noEvidence.observations.plannerPriorEvidenceReadable, [null, false]);
    assert.deepEqual(noEvidence.observations.plannerPriorEvidenceInGit, [null, false]);
    assert.deepEqual(noEvidence.observations.plannerGitHistoryLines, [1, 1]);
    assert.deepEqual(noEvidence.observations.plannerGitPointerReadable, [false, false]);
    assert.deepEqual(hoh.observations.plannerPriorEvidenceReadable, [null, true]);
    assert.deepEqual(hoh.observations.plannerPriorEvidenceInGit, [null, true]);
    const noEvidencePlanner2 = noEvidence.harness.calls.find((call) => call.role === "planner" && call.loopIndex === 2)!.prompt;
    const hohPlanner2 = hoh.harness.calls.find((call) => call.role === "planner" && call.loopIndex === 2)!.prompt;
    assert.ok(!noEvidencePlanner2.includes(EVIDENCE_SENTINEL));
    assert.ok(hohPlanner2.includes(EVIDENCE_SENTINEL));

    const noWarm = byCondition["no-warm-start"];
    assert.deepEqual(noWarm.observations.developerInputs, ["A0\n", "A0\n"]);
    assert.deepEqual(noWarm.observations.developerPriorRuntimeReadable, [null, false]);
    assert.deepEqual(noWarm.observations.developerGitHistoryLines, [1, 1]);
    assert.deepEqual(hoh.observations.developerInputs, ["A0\n", "A0\ndev-1\n"]);
    assert.deepEqual(hoh.observations.developerPriorRuntimeReadable, [null, true]);
    for (const loopIndex of [1, 2]) {
      const developer = (await readJson<DeveloperRecord>(noWarm.paths.developerJson(loopIndex)))!;
      assert.equal(developer.base_commit_sha, noWarm.record.a0.commit_oid);
      assert.equal(developer.base_candidate_id, `loop-00-${noWarm.record.a0.tree_oid.slice(0, 12)}`);
    }

    const vanilla = byCondition.vanilla;
    for (const loopIndex of [1, 2]) {
      assert.equal(await exists(vanilla.paths.plannerJson(loopIndex)), false);
      assert.equal(await exists(vanilla.paths.developmentDocument(loopIndex)), false);
      assert.equal(await exists(vanilla.paths.evidenceJson(loopIndex)), false);
      assert.equal(await exists(vanilla.paths.testerReport(loopIndex)), false);
      assert.equal(await exists(vanilla.paths.developerJson(loopIndex)), true);
    }
    const vanillaBudget = (await readJson<BudgetLedger>(vanilla.paths.budget))!;
    assert.deepEqual(vanillaBudget.attempts.map((attempt) => attempt.role), ["developer", "developer"]);
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
  }
});

test("experiment preflight rejects stale runtime state but accepts the spec-bound claim fixture", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    await mkdir(path.join(ws, ".hoh", "iterations", "loop-01"), { recursive: true });
    await writeFile(path.join(ws, ".hoh", "ledger.json"), "{}\n");
    const observations = emptyObservations();
    const harness = createConditionHarness(observations);
    await assert.rejects(
      runExperimentCondition({
        condition: "hoh",
        workspace: ws,
        specPath: spec,
        harness,
        config: { harness: "mock", loops: 1, checks: [] },
        binding: { plan_sha256: PLAN_SHA256, attempt_id: "stale-attempt", cell_id: "stale-cell" },
      }),
      /fresh \.hoh runtime root.*iterations.*ledger\.json|fresh \.hoh runtime root.*ledger\.json.*iterations/,
    );
    assert.equal(harness.calls.length, 0);
  } finally {
    await cleanup();
  }
});

test("experiment Developers cannot replace the fixed pre-role Git history", async () => {
  for (const condition of ["hoh", "no-warm-start", "vanilla"] as const) {
    const { ws, spec, cleanup } = await makeWorkspace();
    try {
      await writeFile(path.join(ws, "artifact.txt"), "A0\n");
      const observations = emptyObservations();
      const harness = createConditionHarness(observations, { commitHead: true });
      const result = await runExperimentCondition({
        condition,
        workspace: ws,
        specPath: spec,
        harness,
        config: { harness: "mock", loops: 1, checks: [] },
        binding: { plan_sha256: PLAN_SHA256, attempt_id: `head-${condition}`, cell_id: `cell-${condition}` },
      });
      assert.equal(result.status, "completed");
      assert.equal(await exists(path.join(ws, ".hoh", "role-owned.json")), false);
      assert.doesNotMatch((await git(["log", "--format=%s", "HEAD"], ws)).stdout, /role-owned head/);
      const developer = (await readJson<DeveloperRecord>(new RunPaths(ws).developerJson(1)))!;
      assert.ok(developer.violations.some((violation) => violation.includes("moved Git HEAD")));
      assert.match(await readFile(path.join(ws, "artifact.txt"), "utf8"), /dev-1/);
    } finally {
      await cleanup();
    }
  }
});

function roleOrder(fixture: ConditionFixture): string[] {
  return fixture.harness.calls.map((call) => call.role);
}

async function exists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readAllRuntimeText(root: string): Promise<string> {
  const chunks: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) chunks.push(await readFile(absolute, "utf8"));
    }
  };
  await visit(root);
  return chunks.join("\n");
}
