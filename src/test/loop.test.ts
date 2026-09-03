import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";
import { createDemoMockHarness, MockHarness } from "../harness/mock.js";
import { MAX_INLINE_CANDIDATE_DIFF_BYTES } from "../runtime/candidate-diff.js";
import { git, gitLog, headCommit } from "../runtime/git.js";
import { normalizeEvidence, runHoh } from "../runtime/loop.js";
import { ExecutionRecordSchema } from "../runtime/schemas.js";
import { readJson, RunPaths } from "../runtime/state.js";
import type { CheckResult, ClaimCatalog, DeveloperRecord, EvidenceBundle, EvidenceSubmission, Ledger } from "../types.js";
import { makeWorkspace } from "./helpers.js";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function normalizeSubmission(submission: EvidenceSubmission, checks: CheckResult[] = [], claimCatalog?: ClaimCatalog): EvidenceBundle {
  const candidateSha = "a".repeat(64);
  return normalizeEvidence({
    submission,
    loopIndex: 3,
    candidateId: "loop-03-fixture",
    checks,
    before: candidateSha,
    after: candidateSha,
    finalText: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 1, duration_ms: 0 },
    attempts: 1,
    claimCatalog,
  });
}

test("ExecutionRecordSchema accepts only the configured evidence types", () => {
  const configuredTypes = ["run", "test", "check", "screenshot", "replay", "runtime_trace", "log", "storage", "source", "config", "manifest"];
  for (const type of configuredTypes) {
    assert.equal(Check(ExecutionRecordSchema, { type, observation: "collected" }), true, type);
  }
  for (const type of ["build", "runtime", "other", "unknown"]) {
    assert.equal(Check(ExecutionRecordSchema, { type, observation: "collected" }), false, type);
  }
});

test("normalizeEvidence downgrades source/config/manifest-only verified claims", () => {
  const evidence = normalizeSubmission({
    qa_status: "pass",
    summary: "Static files appear to describe the behavior.",
    verified_records: [
      {
        claim_id: "static_only_behavior",
        claim: "The configured feature works at runtime.",
        execution_records: [
          { type: "source", path: "src/feature.ts", observation: "The implementation function exists." },
          { type: "config", path: "feature.config.json", observation: "The feature is enabled." },
          { type: "manifest", path: "package.json", observation: "The feature package is declared." },
        ],
      },
    ],
    gap_records: [],
    planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
  });

  assert.equal(evidence.qa_status, "fail");
  assert.deepEqual(evidence.verified_records, []);
  assert.equal(evidence.gap_records.length, 1);
  assert.equal(evidence.gap_records[0].claim_id, "static_only_behavior");
  assert.equal(evidence.gap_records[0].status, "gap");
  assert.equal(evidence.gap_records[0].severity, "minor");
  assert.deepEqual(
    evidence.gap_records[0].execution_records.map((record) => record.type),
    ["source", "config", "manifest"],
  );
  assert.ok(evidence.runtime_notes.some((note) => /static_only_behavior.*source-only evidence downgraded/i.test(note)));
});

test("normalizeEvidence keeps verified claims for every execution evidence type", async (t) => {
  const executionEvidenceTypes = ["run", "test", "check", "screenshot", "replay", "runtime_trace", "log", "storage"];
  for (const executionType of executionEvidenceTypes) {
    await t.test(executionType, () => {
      const evidence = normalizeSubmission({
        qa_status: "pass",
        summary: "The configured feature was exercised.",
        verified_records: [
          {
            claim_id: "runtime_observed_behavior",
            claim: "The configured feature works at runtime.",
            execution_records: [
              { type: "source", path: "src/feature.ts", observation: "The implementation function exists." },
              { type: executionType, path: "collected-evidence", observation: "The feature produced the expected visible result." },
            ],
          },
        ],
        gap_records: [],
        planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
      });

      assert.equal(evidence.qa_status, "pass");
      assert.equal(evidence.verified_records.length, 1);
      assert.equal(evidence.verified_records[0].claim_id, "runtime_observed_behavior");
      assert.equal(evidence.verified_records[0].status, "verified");
      assert.deepEqual(evidence.gap_records, []);
      assert.ok(!evidence.runtime_notes.some((note) => /source-only evidence downgraded/i.test(note)));
    });
  }
});

test("normalizeEvidence enforces fixed-claim evidence requirements while allowing free claims", () => {
  const catalog: ClaimCatalog = {
    schema_version: 1,
    spec_sha256: "a".repeat(64),
    claims: [{ id: "visual_result", criterion: "The result is visibly distinct.", requires: ["screenshot"] }],
  };
  const submission: EvidenceSubmission = {
    qa_status: "pass",
    summary: "Runtime behavior was exercised without a screenshot.",
    verified_records: [
      { claim_id: "visual_result", claim: "The result is visibly distinct.", execution_records: [{ type: "run", observation: "The result state was reached." }] },
      { claim_id: "free_runtime_claim", claim: "A free behavior works.", execution_records: [{ type: "run", observation: "The free behavior ran." }] },
    ],
    gap_records: [],
    planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
  };

  const evidence = normalizeSubmission(submission, [], catalog);
  assert.deepEqual(evidence.verified_records.map((record) => record.claim_id), ["free_runtime_claim"]);
  assert.equal(evidence.gap_records[0].claim_id, "visual_result");
  assert.match(evidence.runtime_notes.join("\n"), /visual_result: missing required evidence types: screenshot/);
  assert.equal(evidence.qa_status, "partial");
});

test("failed deterministic checks stay blockers and win claim-id conflicts", () => {
  const failedChecks: CheckResult[] = [
    { name: "build", command: "npm run build", status: "fail", exit_code: 1, duration_ms: 10, stdout_tail: "", stderr_tail: "compile failed" },
    { name: "lint", command: "npm run lint", status: "fail", exit_code: 2, duration_ms: 10, stdout_tail: "", stderr_tail: "lint failed" },
  ];
  const evidence = normalizeSubmission(
    {
      qa_status: "partial",
      summary: "The tester supplied weaker records for failed checks.",
      verified_records: [
        { claim_id: "feature_flow", claim: "The feature flow works.", execution_records: [{ type: "run", observation: "The flow completed." }] },
        { claim_id: "check.lint", claim: "The lint check passes.", execution_records: [{ type: "run", observation: "Claimed pass." }] },
      ],
      gap_records: [
        { claim_id: "check.build", claim: "The build check passes.", execution_records: [{ type: "source", observation: "Build script exists." }], severity: "minor" },
      ],
      planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
    },
    failedChecks,
  );

  assert.equal(evidence.qa_status, "fail");
  assert.deepEqual(evidence.verified_records.map((record) => record.claim_id), ["feature_flow"]);
  for (const id of ["check.build", "check.lint"]) {
    const gap = evidence.gap_records.find((record) => record.claim_id === id);
    assert.equal(gap?.severity, "blocker", id);
    assert.ok(gap?.execution_records.some((record) => record.type === "check"), id);
  }
});

test("1945 loop 3 selected claims distinguish recorded execution evidence from a source-only projection", async () => {
  const fixtureUrl = new URL("../../src/test/fixtures/1945-loop-03-selected-evidence.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    source: { run_id: string; loop_index: number; evidence_sha256: string; derivation: string };
    submission: EvidenceSubmission;
  };
  assert.deepEqual(fixture.source, {
    run_id: "20260903-1de3ce",
    loop_index: 3,
    evidence_sha256: "a09ef9b1f7c1e583dc88618a89626e630eca79952f6b35bdd42e3c381c418305",
    derivation: "selected-record projection from original evidence; status fields removed for submission replay",
  });

  const evidence = normalizeSubmission(fixture.submission);
  assert.deepEqual(
    evidence.verified_records.map((record) => record.claim_id),
    ["enemy_type_count", "pickup_medal_and_bomb_cap"],
  );
  assert.deepEqual(
    evidence.verified_records.map((record) => record.execution_records.map((execution) => execution.type)),
    [
      ["source", "test"],
      ["source", "runtime_trace"],
    ],
  );
  assert.deepEqual(evidence.gap_records, []);
  assert.ok(!evidence.runtime_notes.some((note) => /source-only evidence downgraded/i.test(note)));

  const sourceOnlySubmission: EvidenceSubmission = {
    ...fixture.submission,
    verified_records: fixture.submission.verified_records.map((record) => ({
      ...record,
      execution_records: record.execution_records.filter((execution) => execution.type === "source" || execution.type === "config" || execution.type === "manifest"),
    })),
  };
  const sourceOnlyEvidence = normalizeSubmission(sourceOnlySubmission);
  assert.deepEqual(
    sourceOnlyEvidence.gap_records.map((record) => record.claim_id),
    ["enemy_type_count", "pickup_medal_and_bomb_cap"],
  );
  assert.equal(sourceOnlyEvidence.verified_records.length, 0);
  assert.equal(sourceOnlyEvidence.qa_status, "fail");
});

test("e2e: demo mock harness completes two loops and closes the gap", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const harness = createDemoMockHarness();
    const logs: string[] = [];
    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness,
      config: { harness: "mock", loops: 2, checks: [{ name: "list", command: "ls -1 | wc -l" }] },
      log: (m) => logs.push(m),
    });
    const paths = new RunPaths(ws);

    assert.equal(result.results.length, 2);
    const e1 = result.results[0].evidence;
    const e2 = result.results[1].evidence;
    assert.equal(e1.qa_status, "partial");
    assert.deepEqual(
      e1.gap_records.map((g) => g.claim_id),
      ["result_state"],
    );
    assert.equal(e1.frozen, true);
    assert.equal(e1.checks[0].status, "pass");
    assert.equal(e2.qa_status, "pass");
    assert.equal(e2.gap_records.length, 0);

    // Ledger: opened in loop 1, closed in loop 2.
    const ledger = (await readJson<Ledger>(paths.ledger))!;
    assert.equal(ledger.issues.result_state.status, "closed");
    assert.equal(ledger.issues.result_state.first_seen_loop, 1);
    assert.equal(ledger.issues.result_state.closed_loop, 2);

    // Artifact identity changes when the artifact changes.
    const d1 = result.results[0].developer;
    const d2 = result.results[1].developer;
    assert.notEqual(d1.candidate_id, d2.candidate_id);
    assert.match(d1.candidate_id, /^loop-01-[0-9a-f]{12}$/);
    assert.ok(d2.changed_paths.includes("result_state.txt"));
    assert.ok(d1.changed_paths.every((p) => !p.startsWith(".hoh/")), `runtime records are not artifact changes: ${d1.changed_paths}`);
    assert.deepEqual([...d1.changed_paths].sort(), ["main.txt", "player_control.txt"]);
    assert.equal(result.results[1].planner.base_candidate_id, d1.candidate_id);

    // Records on disk.
    for (const f of [
      paths.runJson,
      paths.spec,
      paths.readme,
      paths.plannerJson(1),
      paths.developmentDocument(1),
      paths.developerJson(1),
      paths.checksJson(1),
      paths.evidenceJson(1),
      paths.testerReport(1),
      paths.transcript(1, "planner"),
      paths.transcript(2, "tester"),
    ]) {
      assert.ok(await exists(f), `missing ${f}`);
    }
    const doc2 = await readFile(paths.developmentDocument(2), "utf8");
    assert.match(doc2, /Repair the missing result state/);
    assert.match(doc2, /`result_state` \[major, open, 1 loop\(s\)\]/);

    // Prompts carried the evidence and ledger forward.
    const plannerPrompt2 = harness.calls.find((c) => c.role === "planner" && c.loopIndex === 2)!.prompt;
    assert.match(plannerPrompt2, /Candidate assessed: `loop-01-/);
    assert.match(plannerPrompt2, /`result_state` \[major\]/);
    const testerPrompt1 = harness.calls.find((c) => c.role === "tester" && c.loopIndex === 1)!.prompt;
    assert.match(testerPrompt1, /Candidate id: `loop-01-/);
    assert.match(testerPrompt1, /`list` \| PASS/);

    // Git history: role commits with conventional prefixes and bot identities.
    const log = await gitLog(ws);
    const subjects = log.map((l) => l.subject);
    assert.ok(subjects.some((s) => s.startsWith("docs(loop-01): ")));
    assert.ok(subjects.some((s) => s.startsWith("feat(loop-01): ")));
    assert.ok(subjects.some((s) => s.startsWith("test(loop-01): QA partial for loop-01-")));
    assert.ok(subjects.some((s) => s.startsWith("test(loop-02): QA pass for loop-02-")));
    assert.ok(subjects.some((s) => s.startsWith("chore(hoh): initialize run ")));
    assert.equal(log.find((l) => l.subject.startsWith("feat(loop-01)"))!.author, "hoh-developer-bot");
    assert.equal(log.find((l) => l.subject.startsWith("test(loop-01)"))!.author, "hoh-tester-bot");

    // README record.
    const readme = await readFile(paths.readme, "utf8");
    assert.match(readme, /## Loop 02/);
    assert.match(readme, /Best verified \(last QA PASS\): `loop-02-/);

    // Resume: budget already spent, nothing runs.
    const again = await runHoh({ workspace: ws, harness, log: (m) => logs.push(m) });
    assert.equal(again.results.length, 0);
    // Resume with a larger budget runs exactly one more loop.
    const more = await runHoh({ workspace: ws, harness, config: { loops: 3 }, log: (m) => logs.push(m) });
    assert.equal(more.results.length, 1);
    assert.equal(more.results[0].loopIndex, 3);
  } finally {
    await cleanup();
  }
});

test("tester mutation of the frozen candidate is detected and discarded", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const demo = createDemoMockHarness();
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: (inv, api) => demo["scripts"].developer!(inv, api),
      tester: async (inv, api) => {
        await api.write("hacked.txt", "tester should not write\n");
        api.submit("submit_evidence", {
          qa_status: "pass",
          summary: "all good (lying)",
          verified_records: [{ claim_id: "player_control", claim: "x", execution_records: [] }],
          gap_records: [],
          planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
        });
      },
    });
    const result = await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } });
    const e = result.results[0].evidence;
    assert.equal(e.frozen, false);
    assert.equal(e.qa_status, "fail");
    const mutationGap = e.gap_records.find((g) => g.claim_id === "runtime.candidate_mutated");
    assert.equal(mutationGap?.execution_records[0].type, "runtime_trace");
    assert.notEqual(e.candidate_source_sha256_before, e.candidate_source_sha256_after);
    // The main workspace never saw the mutation.
    assert.equal(await exists(path.join(ws, "hacked.txt")), false);
    const dev = (await readJson<DeveloperRecord>(new RunPaths(ws).developerJson(1)))!;
    assert.equal(dev.candidate_tree_sha, e.candidate_source_sha256_before);
  } finally {
    await cleanup();
  }
});

test("developer changes under .hoh/ are reverted and recorded as violations", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const demo = createDemoMockHarness();
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: async (inv, api) => {
        await api.write(".hoh/ledger.json", "{}");
        await api.write(".hoh/injected.md", "tamper");
        return demo["scripts"].developer!(inv, api);
      },
      tester: (inv, api) => demo["scripts"].tester!(inv, api),
    });
    const result = await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } });
    const dev = result.results[0].developer;
    assert.equal(dev.violations.length, 2);
    assert.equal(await exists(path.join(ws, ".hoh", "injected.md")), false);
    const ledger = (await readJson<Ledger>(new RunPaths(ws).ledger))!;
    assert.equal(ledger.schema_version, 1);
    assert.ok(ledger.issues.result_state, "ledger survived the tamper attempt and recorded the loop-1 gap");
  } finally {
    await cleanup();
  }
});

test("planner without structured output is retried once, then the loop fails", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const harness = new MockHarness({ planner: () => "I refuse to call tools." });
    await assert.rejects(runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } }), /planner returned no development document after 2 attempt/);
    assert.equal(harness.calls.filter((c) => c.role === "planner").length, 2);
    assert.match(harness.calls[1].prompt, /Runtime notice/);
    const paths = new RunPaths(ws);
    assert.ok(await exists(paths.errorJson(1)));
  } finally {
    await cleanup();
  }
});

test("tester without structured output yields a failing evidence bundle instead of aborting", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const demo = createDemoMockHarness();
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: (inv, api) => demo["scripts"].developer!(inv, api),
      tester: () => "Looks fine to me.",
    });
    const result = await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } });
    const e = result.results[0].evidence;
    assert.equal(e.qa_status, "fail");
    assert.equal(e.gap_records[0].claim_id, "tester.no_structured_output");
    assert.equal(e.gap_records[0].execution_records[0].type, "log");
    assert.equal(harness.calls.filter((c) => c.role === "tester").length, 2);
  } finally {
    await cleanup();
  }
});

test("failed deterministic check becomes a blocker gap and fails QA", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness: createDemoMockHarness(),
      config: { harness: "mock", loops: 1, checks: [{ name: "build", command: "test -f does-not-exist.txt" }] },
    });
    const e: EvidenceBundle = result.results[0].evidence;
    assert.equal(e.checks[0].status, "fail");
    assert.equal(e.qa_status, "fail");
    assert.ok(e.gap_records.some((g) => g.claim_id === "check.build" && g.severity === "blocker"));
  } finally {
    await cleanup();
  }
});

test("a deterministic check that mutates candidate source invalidates QA", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness: createDemoMockHarness(),
      config: { harness: "mock", loops: 1, checks: [{ name: "mutating-check", command: 'printf "changed by check\\n" >> main.txt' }] },
    });
    const evidence = result.results[0].evidence;
    assert.equal(evidence.qa_status, "fail");
    assert.ok(evidence.gap_records.some((record) => record.claim_id === "runtime.candidate_mutated_by_checks"));
    assert.match(evidence.runtime_notes.join("\n"), /candidate mutated during deterministic checks/);
  } finally {
    await cleanup();
  }
});

test("a workspace that already contains an artifact is treated as a provided loop-00 candidate", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, "main.txt"), "pre-existing artifact\n");
    const harness = createDemoMockHarness();
    const result = await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } });
    assert.match(result.results[0].planner.base_candidate_id ?? "", /^loop-00-[0-9a-f]{12}$/);
    const devPrompt = harness.calls.find((c) => c.role === "developer")!.prompt;
    assert.match(devPrompt, /provided initial artifact/);
    assert.doesNotMatch(devPrompt, /artifact directory is empty/);
    const planPrompt = harness.calls.find((c) => c.role === "planner")!.prompt;
    assert.match(planPrompt, /loop-00-[0-9a-f]{12} \(provided initial artifact/);
  } finally {
    await cleanup();
  }
});

test("mid-loop resume: a crashed tester is re-run without repeating planner and developer", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const demo = createDemoMockHarness();
    let testerCalls = 0;
    const crashing = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: (inv, api) => demo["scripts"].developer!(inv, api),
      tester: () => {
        testerCalls++;
        throw new Error("simulated gateway outage");
      },
    });
    await assert.rejects(runHoh({ workspace: ws, specPath: spec, harness: crashing, config: { harness: "mock", loops: 1 } }), /simulated gateway outage/);
    assert.equal(testerCalls, 1);
    const paths = new RunPaths(ws);
    assert.ok(await exists(paths.developerJson(1)));
    assert.equal(await exists(paths.evidenceJson(1)), false);
    const before = (await readJson<DeveloperRecord>(paths.developerJson(1)))!;
    assert.ok(before.base_commit_sha);
    assert.ok(before.candidate_commit_sha);
    const errorCommit = await headCommit(ws);
    assert.notEqual(errorCommit, before.candidate_commit_sha, "the runtime error record advances only the main workspace HEAD");

    const healthyDemo = createDemoMockHarness();
    let resumedWorktreeHead = "";
    const healthy = new MockHarness({
      tester: async (inv, api) => {
        resumedWorktreeHead = (await git(["rev-parse", "HEAD"], inv.cwd)).stdout.trim();
        return healthyDemo["scripts"].tester!(inv, api);
      },
    });
    const result = await runHoh({ workspace: ws, harness: healthy });
    assert.deepEqual(
      healthy.calls.map((c) => c.role),
      ["tester"],
      "only the tester runs on resume",
    );
    assert.equal(result.results[0].developer.candidate_id, before.candidate_id);
    assert.equal(result.results[0].evidence.candidate_id, before.candidate_id);
    assert.equal(resumedWorktreeHead, before.candidate_commit_sha, "resume freezes the originally recorded candidate commit");
    const resumedPrompt = healthy.calls[0].prompt;
    assert.match(resumedPrompt, new RegExp(`Base Git commit: \`${before.base_commit_sha}\``));
    assert.match(resumedPrompt, new RegExp(`Candidate Git commit: \`${before.candidate_commit_sha}\``));
    assert.equal(result.results[0].planner.objective, "Bootstrap a launchable artifact with a visible player control loop");
    assert.ok(await exists(paths.evidenceJson(1)));
    assert.equal(await exists(paths.errorJson(1)), false, "the superseded error record is removed");
    // no stale worktrees remain
    const { gitLog: _g } = await import("../runtime/git.js");
    const wtList = (await import("../runtime/git.js")).git;
    const list = await wtList(["worktree", "list"], ws);
    assert.equal(list.stdout.trim().split("\n").length, 1, list.stdout);
  } finally {
    await cleanup();
  }
});

test("checks and worktree_setup see HOH_* environment variables", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness: createDemoMockHarness(),
      config: {
        harness: "mock",
        loops: 1,
        worktree_setup: 'test "$(pwd)" = "$HOH_CANDIDATE_DIR" && test -d "$HOH_WORKSPACE/.hoh" && echo setup-ok',
        checks: [{ name: "env", command: 'test -n "$HOH_RUN_ID" && test "$HOH_LOOP" = 1 && test "$HOH_ROLE" = check && test "$HOH_WORKSPACE" != "$HOH_CANDIDATE_DIR"' }],
      },
    });
    const e = result.results[0].evidence;
    assert.deepEqual(
      e.checks.map((c) => [c.name, c.status]),
      [
        ["setup", "pass"],
        ["env", "pass"],
      ],
    );
    assert.match(e.checks[0].stdout_tail, /setup-ok/);
    assert.equal(process.env.HOH_WORKSPACE, path.resolve(ws));
  } finally {
    await cleanup();
  }
});

test("candidate identity is the artifact_dir subtree; tooling outside it does not change the candidate", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(ws, "game"), { recursive: true });
    await mkdir(path.join(ws, "tools"), { recursive: true });
    await writeFile(path.join(ws, "game", "index.html"), "<canvas></canvas>");
    await writeFile(path.join(ws, "tools", "check.sh"), "echo ok");
    const harness = new MockHarness({
      planner: (inv, api) => createDemoMockHarness()["scripts"].planner!(inv, api),
      developer: async (inv, api) => {
        await api.write("tools/check.sh", "echo changed tooling");
        return "touched only tooling";
      },
      tester: (inv, api) => createDemoMockHarness()["scripts"].tester!(inv, api),
    });
    const r1 = await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1, artifact_dir: "game" } });
    const d1 = r1.results[0].developer;
    assert.match(r1.results[0].planner.base_candidate_id ?? "", /^loop-00-/);
    // same game/ content as the provided artifact -> same tree hash as loop-00
    assert.equal(`loop-00-${d1.candidate_tree_sha.slice(0, 12)}`, r1.results[0].planner.base_candidate_id);
    assert.ok(d1.changed_paths.includes("tools/check.sh"));

    const harness2 = new MockHarness({
      planner: (inv, api) => createDemoMockHarness()["scripts"].planner!(inv, api),
      developer: async (inv, api) => {
        await api.write("game/index.html", "<canvas></canvas><script>1</script>");
        return "changed the game";
      },
      tester: (inv, api) => createDemoMockHarness()["scripts"].tester!(inv, api),
    });
    const r2 = await runHoh({ workspace: ws, harness: harness2, config: { loops: 2 } });
    assert.notEqual(r2.results[0].developer.candidate_tree_sha, d1.candidate_tree_sha);
  } finally {
    await cleanup();
  }
});

test("tester receives an exact, artifact-scoped base-vs-candidate diff", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(ws, "game"), { recursive: true });
    await mkdir(path.join(ws, "tools"), { recursive: true });
    await writeFile(path.join(ws, "game", "product.txt"), "before\n");
    await writeFile(path.join(ws, "tools", "helper.txt"), "before\n");
    const demo = createDemoMockHarness();
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: async (_inv, api) => {
        await api.write("game/product.txt", "IN_SCOPE_DIFF\n");
        await api.write("tools/helper.txt", "OUT_OF_SCOPE_DIFF\n");
        return "Updated the candidate and its external helper.";
      },
      tester: (inv, api) => demo["scripts"].tester!(inv, api),
    });

    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness,
      config: { harness: "mock", loops: 1, artifact_dir: "game" },
    });
    const developer = result.results[0].developer;
    assert.ok(developer.base_commit_sha);
    assert.ok(developer.candidate_commit_sha);
    assert.ok(developer.changed_paths.includes("game/product.txt"));
    assert.ok(developer.changed_paths.includes("tools/helper.txt"), "the audit record keeps non-runtime changes outside artifact_dir");

    const prompt = harness.calls.find((call) => call.role === "tester")!.prompt;
    const block = /--- BEGIN CANDIDATE DIFF ---\n([\s\S]*?)\n--- END CANDIDATE DIFF ---/.exec(prompt)?.[1] ?? "";
    assert.match(prompt, new RegExp(`Base Git commit: \`${developer.base_commit_sha}\``));
    assert.match(prompt, new RegExp(`Candidate Git commit: \`${developer.candidate_commit_sha}\``));
    assert.match(prompt, new RegExp(`${developer.base_commit_sha}\\.\\.${developer.candidate_commit_sha}`));
    assert.match(prompt, /Inline mode: `full`/);
    assert.match(block, /### Diff stat[\s\S]*### Changed files[\s\S]*### Patch/);
    assert.match(block, /game\/product\.txt/);
    assert.match(block, /IN_SCOPE_DIFF/);
    assert.doesNotMatch(block, /tools\/helper\.txt|OUT_OF_SCOPE_DIFF|\.hoh\//);
    assert.match(prompt, /':\(top,literal\)game'/);
  } finally {
    await cleanup();
  }
});

test("large candidate diffs expose only bounded metadata and hunk headers", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const demo = createDemoMockHarness();
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: async (_inv, api) => {
        // The source line deliberately resembles a `+++` file header after Git adds its `+` body prefix.
        await api.write("huge.txt", `++ BODY_SENTINEL_${"한".repeat(MAX_INLINE_CANDIDATE_DIFF_BYTES)}\n`);
        return "Created one large candidate file.";
      },
      tester: (inv, api) => demo["scripts"].tester!(inv, api),
    });

    const result = await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } });
    const developer = result.results[0].developer;
    const prompt = harness.calls.find((call) => call.role === "tester")!.prompt;
    const block = /--- BEGIN CANDIDATE DIFF ---\n([\s\S]*?)\n--- END CANDIDATE DIFF ---/.exec(prompt)?.[1] ?? "";

    assert.match(prompt, /Inline mode: `headers`/);
    assert.ok(Buffer.byteLength(block, "utf8") <= MAX_INLINE_CANDIDATE_DIFF_BYTES);
    assert.match(block, /Full patch omitted/);
    assert.match(block, /diff --git a\/huge\.txt b\/huge\.txt/);
    assert.match(block, /^@@/m);
    assert.doesNotMatch(block, /BODY_SENTINEL/);
    assert.doesNotMatch(block, /\.hoh\//);
    assert.match(prompt, new RegExp(`${developer.base_commit_sha}\\.\\.${developer.candidate_commit_sha}`));
    assert.match(prompt, /git --no-pager diff --patch --unified=3 --no-color --no-ext-diff --no-textconv --no-renames/);
  } finally {
    await cleanup();
  }
});

test("tester changes to runtime-owned .hoh records are reverted and block QA", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const demo = createDemoMockHarness();
    const { writeFile } = await import("node:fs/promises");
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: (inv, api) => demo["scripts"].developer!(inv, api),
      tester: async (inv, api) => {
        // The Tester knows the main workspace path but may write only inside its evidence directory.
        await writeFile(path.join(ws, ".hoh", "pi-models.json"), JSON.stringify({ providers: {}, changed: Date.now() }));
        return demo["scripts"].tester!(inv, api);
      },
    });
    const result = await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } });
    const e = result.results[0].evidence;
    assert.ok(e.gap_records.some((g) => g.claim_id === "runtime.workspace_mutated_by_tester"), JSON.stringify(e.gap_records.map((g) => g.claim_id)));
    assert.equal(e.qa_status, "fail");
    assert.equal(await exists(path.join(ws, ".hoh", "pi-models.json")), false);
  } finally {
    await cleanup();
  }
});

test("runtime-owned record changes present before the developer starts are committed by the runtime, not blamed on the developer", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const { writeFile } = await import("node:fs/promises");
    const harness = createDemoMockHarness();
    await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } });
    // Simulate start-up regeneration of a runtime-owned file (e.g. the provider models file) before the next invocation.
    await writeFile(path.join(ws, ".hoh", "pi-models.json"), JSON.stringify({ providers: { p: { models: [] } } }));
    const result = await runHoh({ workspace: ws, harness, config: { loops: 2 } });
    const dev = result.results[0].developer;
    assert.deepEqual(dev.violations, []);
    const { git } = await import("../runtime/git.js");
    const who = await git(["log", "--format=%an", "-1", "--", ".hoh/pi-models.json"], ws);
    assert.equal(who.stdout.trim(), "hoh-runtime", "the regenerated record was committed by the runtime, not by a role");
    assert.equal((await git(["status", "--porcelain", "--", ".hoh/pi-models.json"], ws)).stdout.trim(), "");
  } finally {
    await cleanup();
  }
});
