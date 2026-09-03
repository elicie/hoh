import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MockHarness } from "../harness/mock.js";
import {
  aggregateExperimentDirectory,
  experimentAssignments,
  EXPERIMENT_AGGREGATE_FILE,
  EXPERIMENT_COMPLETE_FILE,
  EXPERIMENT_MANIFEST_FILE,
  EXPERIMENT_RAW_RESULTS_FILE,
  registerExperiment,
  runExperimentAttempt,
} from "../experiment/orchestrator.js";
import { parseExperimentManifest, type ExperimentBudget } from "../experiment/manifest.js";
import { git } from "../runtime/git.js";
import { canonicalSha256 } from "../runtime/protocol.js";
import type { EvidenceSubmission } from "../types.js";
import { DEMO_CLAIMS, DEMO_SPEC } from "./helpers.js";

const TASK_ID = "task-001";
const SAMPLE_ID = "sample-001";
const EVALUATOR_TASK = "Score the packaged artifact against the public product specification.";
const EVALUATOR_SAMPLE = "PRIVATE_EVALUATOR_SAMPLE_74f20d";
const METRIC = "score";
const CONFIG = {
  protocol: "paper" as const,
  harness: "mock" as const,
  loops: 1,
  models: { default: "shared-model" },
  checks: [],
};

interface Fixture {
  readonly root: string;
  readonly experiment: string;
  readonly baseline: string;
  readonly spec: string;
  readonly marker: string;
  readonly evaluator: {
    readonly argv: readonly string[];
    readonly version: string;
    readonly rubric_sha256: string;
    readonly executable_sha256: string;
  };
  readonly cleanup: () => Promise<void>;
}

async function fixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), `hoh-orchestrator-${label}-`));
  const experiment = path.join(root, "experiment");
  const baseline = path.join(root, "baseline");
  const spec = path.join(root, "PRD.md");
  const marker = path.join(root, "evaluator.marker");
  await writeFile(spec, DEMO_SPEC);
  await seedWorkspace(baseline);
  const script = [
    "const fs=require('node:fs');",
    "let raw='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',chunk=>raw+=chunk);",
    "process.stdin.on('end',()=>{",
    "  const input=JSON.parse(raw);",
    "  const artifact=Buffer.from(input.artifact.content,'base64');",
    "  if(!artifact.includes(Buffer.from('evaluated candidate'))) throw new Error('candidate missing');",
    "  fs.appendFileSync(process.argv[1],'evaluated\\n');",
    `  process.stdout.write(JSON.stringify({${METRIC}:1}));`,
    "});",
  ].join("\n");
  return {
    root,
    experiment,
    baseline,
    spec,
    marker,
    evaluator: {
      argv: [process.execPath, "-e", script, marker],
      version: "test-evaluator@1",
      rubric_sha256: canonicalSha256("test rubric v1"),
      executable_sha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function seedWorkspace(workspace: string, product = "A0\n"): Promise<void> {
  await mkdir(path.join(workspace, ".hoh"), { recursive: true });
  await writeFile(path.join(workspace, "artifact.txt"), product);
  await writeFile(
    path.join(workspace, ".hoh", "claims.json"),
    `${JSON.stringify({
      schema_version: 1,
      spec_sha256: createHash("sha256").update(DEMO_SPEC).digest("hex"),
      claims: DEMO_CLAIMS,
    })}\n`,
  );
}

function harness(onInvoke?: () => Promise<void> | void, developerProduct = "evaluated candidate\n"): MockHarness {
  return new MockHarness({
    planner: async (inv, api) => {
      await onInvoke?.();
      api.submit("submit_development_document", {
        objective: "produce the evaluated candidate",
        priorities: [
          {
            name: "artifact",
            action: "update artifact.txt",
            observable_outcome: "artifact.txt contains the evaluated candidate marker",
          },
        ],
        preservation_gate: [],
        acceptance_gate: ["artifact.txt is readable"],
      });
      return "planned";
    },
    developer: async (inv, api) => {
      await onInvoke?.();
      assert.doesNotMatch(`${inv.systemPrompt}\n${inv.prompt}`, new RegExp(EVALUATOR_SAMPLE));
      await api.write("artifact.txt", developerProduct);
      return "developed";
    },
    tester: async (inv, api) => {
      await onInvoke?.();
      const submission: EvidenceSubmission = {
        qa_status: "pass",
        summary: "the public artifact behavior was checked",
        verified_records: [
          {
            claim_id: "free.artifact",
            claim: "the artifact is readable",
            execution_records: [{ type: "run", observation: "artifact.txt contained the expected public marker" }],
          },
        ],
        gap_records: [],
        planner_handoff: {
          preservation_constraints: ["preserve artifact readability"],
          update_targets: [],
          validation_requirements: ["read artifact.txt"],
        },
      };
      api.submit("submit_evidence", submission);
      return "tested";
    },
  });
}

async function register(base: Fixture, budget: ExperimentBudget = { unit: "total_tokens", limit: 1000 }) {
  return registerExperiment({
    experiment_root: base.experiment,
    samples: [
      {
        task_id: TASK_ID,
        sample_id: SAMPLE_ID,
        workspace: base.baseline,
        spec_path: base.spec,
        evaluator_task: EVALUATOR_TASK,
        evaluator_sample: EVALUATOR_SAMPLE,
      },
    ],
    repetitions: 1,
    assignment_seed: 7429,
    budget,
    evaluator: base.evaluator,
    metric: METRIC,
    exclusion_rules: [
      "budget_exhausted",
      "cancelled",
      "timed_out",
      "output_too_large",
      "spawn_error",
      "nonzero_exit",
      "invalid_json",
      "evaluator_identity_mismatch",
    ],
    retry: { max_attempts: 1, retryable_failure_codes: [] },
    harness: harness(),
    config: CONFIG,
  });
}

test("experiment orchestrator pre-registers and evaluates all five conditions before deterministic aggregation", async () => {
  const base = await fixture("matrix");
  const originalEnvironment = {
    HOH_WORKSPACE: process.env.HOH_WORKSPACE,
    HOH_RUN_ID: process.env.HOH_RUN_ID,
    HOH_LOOP: process.env.HOH_LOOP,
    HOH_ROLE: process.env.HOH_ROLE,
    HOH_CANDIDATE_DIR: process.env.HOH_CANDIDATE_DIR,
    HOH_EVIDENCE_DIR: process.env.HOH_EVIDENCE_DIR,
  };
  process.env.HOH_WORKSPACE = "caller-workspace-sentinel";
  process.env.HOH_RUN_ID = "caller-run-sentinel";
  process.env.HOH_LOOP = "caller-loop-sentinel";
  process.env.HOH_ROLE = "caller-role-sentinel";
  process.env.HOH_CANDIDATE_DIR = "caller-candidate-sentinel";
  process.env.HOH_EVIDENCE_DIR = "caller-evidence-sentinel";
  try {
    const manifest = await register(base);
    assert.equal(manifest.schema_version, 2);
    assert.deepEqual(manifest.attempts, []);
    assert.equal(manifest.plan.execution.artifact_packager, "git-archive-tar-v1");
    assert.equal(manifest.plan.execution.resolved_model, "mock:shared-model");
    assert.equal(manifest.plan.cells.length, 5);

    const firstOrder = experimentAssignments(manifest);
    assert.equal(firstOrder.length, 5);
    assert.deepEqual(experimentAssignments(manifest), firstOrder, "the same seed and plan must produce the same assignment order");
    assert.deepEqual(new Set(firstOrder.map((assignment) => assignment.condition)).size, 5);

    for (const [index, assignment] of firstOrder.entries()) {
      const workspace = path.join(base.root, `run-${index + 1}`);
      await seedWorkspace(workspace);
      const roleHarness = harness(async () => {
        const stored = parseExperimentManifest(JSON.parse(await readFile(path.join(base.experiment, EXPERIMENT_MANIFEST_FILE), "utf8")));
        assert.equal(stored.plan_sha256, manifest.plan_sha256, "the immutable manifest must exist before the first role invocation");
      });
      const result = await runExperimentAttempt({
        experiment_root: base.experiment,
        attempt_id: `attempt-${index + 1}`,
        cell_id: assignment.cell_id,
        task_id: assignment.task_id,
        sample_id: assignment.sample_id,
        repetition: assignment.repetition,
        workspace,
        spec_path: base.spec,
        evaluator_task: EVALUATOR_TASK,
        evaluator_sample: EVALUATOR_SAMPLE,
        harness: roleHarness,
        config: CONFIG,
      });
      assert.equal(result.attempt.status, "completed");
      assert.equal(result.attempt.valid, true);
      assert.equal(result.raw_result?.metric.value, 1);
      assert.equal(result.attempt.evaluator_receipt_sha256, result.raw_result?.evaluator_receipt_sha256);
      assert.equal(process.env.HOH_WORKSPACE, "caller-workspace-sentinel");
      assert.equal(process.env.HOH_RUN_ID, "caller-run-sentinel");
      assert.equal(process.env.HOH_LOOP, "caller-loop-sentinel");
      assert.equal(process.env.HOH_ROLE, "caller-role-sentinel");
      assert.equal(process.env.HOH_CANDIDATE_DIR, "caller-candidate-sentinel");
      assert.equal(process.env.HOH_EVIDENCE_DIR, "caller-evidence-sentinel");
    }

    assert.equal((await readFile(base.marker, "utf8")).trim().split("\n").length, 5, "the evaluator must run exactly once per completed condition");
    const storedManifest = parseExperimentManifest(JSON.parse(await readFile(path.join(base.experiment, EXPERIMENT_MANIFEST_FILE), "utf8")));
    assert.equal(storedManifest.attempts.length, 5);
    assert.equal((await readFile(path.join(base.experiment, EXPERIMENT_RAW_RESULTS_FILE), "utf8")).trim().split("\n").length, 5);

    const aggregate = await aggregateExperimentDirectory(base.experiment);
    assert.deepEqual(
      aggregate.conditions.map((condition) => ({ condition: condition.condition, count: condition.count, mean: condition.mean })),
      [
        { condition: "hoh", count: 1, mean: 1 },
        { condition: "vanilla", count: 1, mean: 1 },
        { condition: "no-plan-update", count: 1, mean: 1 },
        { condition: "no-evidence", count: 1, mean: 1 },
        { condition: "no-warm-start", count: 1, mean: 1 },
      ],
    );
    assert.equal((await stat(path.join(base.experiment, EXPERIMENT_AGGREGATE_FILE))).isFile(), true);
    assert.equal((await stat(path.join(base.experiment, EXPERIMENT_COMPLETE_FILE))).isFile(), true);
    assert.deepEqual(await aggregateExperimentDirectory(base.experiment), aggregate, "the completion anchor must verify on reload");
    const sealedWorkspace = path.join(base.root, "sealed-run");
    await seedWorkspace(sealedWorkspace);
    const sealedHarness = harness();
    await assert.rejects(
      runExperimentAttempt({
        experiment_root: base.experiment,
        attempt_id: "sealed-attempt",
        cell_id: "hoh",
        task_id: TASK_ID,
        sample_id: SAMPLE_ID,
        repetition: 1,
        workspace: sealedWorkspace,
        spec_path: base.spec,
        evaluator_task: EVALUATOR_TASK,
        evaluator_sample: EVALUATOR_SAMPLE,
        harness: sealedHarness,
        config: CONFIG,
      }),
      /completed experiment is sealed/,
    );
    assert.equal(sealedHarness.calls.length, 0);
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await base.cleanup();
  }
});

test("experiment orchestrator rejects budget and sample drift before invoking a role", async () => {
  const base = await fixture("preflight");
  try {
    await assert.rejects(
      registerExperiment({
        experiment_root: base.experiment,
        samples: [
          {
            task_id: TASK_ID,
            sample_id: SAMPLE_ID,
            workspace: base.baseline,
            spec_path: base.spec,
            evaluator_task: EVALUATOR_TASK,
            evaluator_sample: EVALUATOR_SAMPLE,
          },
        ],
        repetitions: 1,
        assignment_seed: 1,
        budget: { unit: "total_tokens", limit: 1000 },
        evaluator: base.evaluator,
        metric: METRIC,
        exclusion_rules: [],
        retry: { max_attempts: 1, retryable_failure_codes: [] },
        harness: harness(),
        config: { ...CONFIG, budgets: { role: { total_tokens: 1000 }, run: { total_tokens: 1000 } } },
      }),
      /budgets must contain only the exact pre-registered run limit/,
    );

    await register(base);
    const workspace = path.join(base.root, "drifted-run");
    await seedWorkspace(workspace, "changed A0\n");
    const roleHarness = harness();
    await assert.rejects(
      runExperimentAttempt({
        experiment_root: base.experiment,
        attempt_id: "drifted-attempt",
        cell_id: "hoh",
        task_id: TASK_ID,
        sample_id: SAMPLE_ID,
        repetition: 1,
        workspace,
        spec_path: base.spec,
        evaluator_task: EVALUATOR_TASK,
        evaluator_sample: EVALUATOR_SAMPLE,
        harness: roleHarness,
        config: CONFIG,
      }),
      /does not match the pre-registered A0 product tree/,
    );
    assert.equal(roleHarness.calls.length, 0);
    assert.equal(await exists(base.marker), false);
  } finally {
    await base.cleanup();
  }
});

test("experiment orchestrator rejects Git archive transforms before the evaluator and leaves the manifest unextended", async () => {
  const base = await fixture("archive-transform");
  try {
    const manifest = await register(base);
    const workspace = path.join(base.root, "run");
    await seedWorkspace(workspace);
    const roleHarness = harness(undefined, "evaluated candidate\n");
    const originalInvoke = roleHarness.invoke.bind(roleHarness);
    roleHarness.invoke = async (inv) => {
      const result = await originalInvoke(inv);
      if (inv.role === "developer") await writeFile(path.join(inv.cwd, ".gitattributes"), "* export-ignore\n");
      return result;
    };
    await assert.rejects(
      runExperimentAttempt({
        experiment_root: base.experiment,
        attempt_id: "transform-attempt",
        cell_id: "hoh",
        task_id: TASK_ID,
        sample_id: SAMPLE_ID,
        repetition: 1,
        workspace,
        spec_path: base.spec,
        evaluator_task: EVALUATOR_TASK,
        evaluator_sample: EVALUATOR_SAMPLE,
        harness: roleHarness,
        config: CONFIG,
      }),
      /uses a Git archive transform/,
    );
    assert.equal(await exists(base.marker), false);
    const stored = parseExperimentManifest(JSON.parse(await readFile(path.join(base.experiment, EXPERIMENT_MANIFEST_FILE), "utf8")));
    assert.equal(stored.plan_sha256, manifest.plan_sha256);
    assert.deepEqual(stored.attempts, []);
    const retryWorkspace = path.join(base.root, "retry-run");
    await seedWorkspace(retryWorkspace);
    const retryHarness = harness();
    await assert.rejects(
      runExperimentAttempt({
        experiment_root: base.experiment,
        attempt_id: "retry-after-transform",
        cell_id: "vanilla",
        task_id: TASK_ID,
        sample_id: SAMPLE_ID,
        repetition: 1,
        workspace: retryWorkspace,
        spec_path: base.spec,
        evaluator_task: EVALUATOR_TASK,
        evaluator_sample: EVALUATOR_SAMPLE,
        harness: retryHarness,
        config: CONFIG,
      }),
      /incomplete attempt intent/,
    );
    assert.equal(retryHarness.calls.length, 0);
    await assert.rejects(aggregateExperimentDirectory(base.experiment), /incomplete attempt intent/);
  } finally {
    await base.cleanup();
  }
});

test("experiment orchestrator rejects overlapping condition runs in one process", async () => {
  const base = await fixture("sequential");
  let releaseFirst!: () => void;
  let markEntered!: () => void;
  const release = new Promise<void>((resolve) => (releaseFirst = resolve));
  const entered = new Promise<void>((resolve) => (markEntered = resolve));
  let blocked = false;
  try {
    await register(base);
    const firstWorkspace = path.join(base.root, "first-run");
    const secondWorkspace = path.join(base.root, "second-run");
    await seedWorkspace(firstWorkspace);
    await seedWorkspace(secondWorkspace);
    const firstHarness = harness(async () => {
      if (blocked) return;
      blocked = true;
      markEntered();
      await release;
    });
    const first = runExperimentAttempt({
      experiment_root: base.experiment,
      attempt_id: "first-attempt",
      cell_id: "hoh",
      task_id: TASK_ID,
      sample_id: SAMPLE_ID,
      repetition: 1,
      workspace: firstWorkspace,
      spec_path: base.spec,
      evaluator_task: EVALUATOR_TASK,
      evaluator_sample: EVALUATOR_SAMPLE,
      harness: firstHarness,
      config: CONFIG,
    });
    await entered;
    const secondHarness = harness();
    await assert.rejects(
      runExperimentAttempt({
        experiment_root: base.experiment,
        attempt_id: "second-attempt",
        cell_id: "vanilla",
        task_id: TASK_ID,
        sample_id: SAMPLE_ID,
        repetition: 1,
        workspace: secondWorkspace,
        spec_path: base.spec,
        evaluator_task: EVALUATOR_TASK,
        evaluator_sample: EVALUATOR_SAMPLE,
        harness: secondHarness,
        config: CONFIG,
      }),
      /condition runs must be sequential/,
    );
    assert.equal(secondHarness.calls.length, 0);
    releaseFirst();
    assert.equal((await first).attempt.status, "completed");
  } finally {
    releaseFirst?.();
    await base.cleanup();
  }
});

test("experiment orchestrator preserves a pre-evaluation budget exclusion without inventing an evaluator result", async () => {
  const base = await fixture("budget-exclusion");
  try {
    await register(base, { unit: "total_tokens", limit: 1 });
    const workspace = path.join(base.root, "run");
    await seedWorkspace(workspace);
    const chargingHarness = harness();
    const originalInvoke = chargingHarness.invoke.bind(chargingHarness);
    chargingHarness.invoke = async (inv) => {
      const result = await originalInvoke(inv);
      return { ...result, usage: { ...result.usage, input: 10, totalTokens: 10 } };
    };
    const result = await runExperimentAttempt({
      experiment_root: base.experiment,
      attempt_id: "budget-attempt",
      cell_id: "hoh",
      task_id: TASK_ID,
      sample_id: SAMPLE_ID,
      repetition: 1,
      workspace,
      spec_path: base.spec,
      evaluator_task: EVALUATOR_TASK,
      evaluator_sample: EVALUATOR_SAMPLE,
      harness: chargingHarness,
      config: CONFIG,
    });
    assert.equal(result.condition_result.status, "budget_exhausted");
    assert.equal(result.attempt.status, "failed");
    assert.equal(result.attempt.failure?.code, "budget_exhausted");
    assert.equal(result.attempt.evaluator_receipt_sha256, null);
    assert.equal(result.evaluator_receipt, null);
    assert.equal(result.raw_result, null);
    assert.equal(await exists(base.marker), false);
    assert.equal(await readFile(path.join(base.experiment, EXPERIMENT_RAW_RESULTS_FILE), "utf8"), "");
  } finally {
    await base.cleanup();
  }
});

test("experiment archive ignores ambient Git attributes and preserves SHA-256 repository objects", async () => {
  const base = await fixture("sha256-archive");
  const ambientAttributes = path.join(base.root, "ambient-attributes");
  const previous = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  };
  try {
    await git(["init", "-q", "--object-format=sha256"], base.baseline);
    await register(base);
    const workspace = path.join(base.root, "run");
    await seedWorkspace(workspace);
    await git(["init", "-q", "--object-format=sha256"], workspace);
    await writeFile(ambientAttributes, "* export-ignore\n");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.attributesFile";
    process.env.GIT_CONFIG_VALUE_0 = ambientAttributes;
    const result = await runExperimentAttempt({
      experiment_root: base.experiment,
      attempt_id: "sha256-attempt",
      cell_id: "vanilla",
      task_id: TASK_ID,
      sample_id: SAMPLE_ID,
      repetition: 1,
      workspace,
      spec_path: base.spec,
      evaluator_task: EVALUATOR_TASK,
      evaluator_sample: EVALUATOR_SAMPLE,
      harness: harness(),
      config: CONFIG,
    });
    assert.equal(result.attempt.status, "completed");
    assert.match(result.condition_result.final_artifact.tree_oid, /^[0-9a-f]{64}$/);
    assert.equal((await readFile(base.marker, "utf8")).trim(), "evaluated");
  } finally {
    restoreEnvironment("GIT_CONFIG_COUNT", previous.count);
    restoreEnvironment("GIT_CONFIG_KEY_0", previous.key);
    restoreEnvironment("GIT_CONFIG_VALUE_0", previous.value);
    await base.cleanup();
  }
});

test("experiment storage rejects a replaced receipt-directory symlink before invoking roles", async () => {
  const base = await fixture("receipt-symlink");
  try {
    await register(base);
    const receipts = path.join(base.experiment, "receipts");
    const outside = path.join(base.root, "outside-receipts");
    await rm(receipts, { recursive: true });
    await mkdir(outside);
    await symlink(outside, receipts, "dir");
    const workspace = path.join(base.root, "run");
    await seedWorkspace(workspace);
    const roleHarness = harness();
    await assert.rejects(
      runExperimentAttempt({
        experiment_root: base.experiment,
        attempt_id: "symlink-attempt",
        cell_id: "hoh",
        task_id: TASK_ID,
        sample_id: SAMPLE_ID,
        repetition: 1,
        workspace,
        spec_path: base.spec,
        evaluator_task: EVALUATOR_TASK,
        evaluator_sample: EVALUATOR_SAMPLE,
        harness: roleHarness,
        config: CONFIG,
      }),
      /receipt directory must be a non-symlink directory/,
    );
    assert.equal(roleHarness.calls.length, 0);
  } finally {
    await base.cleanup();
  }
});

async function exists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
