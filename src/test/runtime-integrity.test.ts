import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runExperimentCondition } from "../experiment/conditions.js";
import { createDemoMockHarness, MockHarness } from "../harness/mock.js";
import { requirePlanApproval } from "../runtime/approval.js";
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from "../runtime/config.js";
import { git } from "../runtime/git.js";
import { runHoh } from "../runtime/loop.js";
import { readJson, RunPaths } from "../runtime/state.js";
import { makeWorkspace } from "./helpers.js";

test("QA shell success cannot invent a verified claim or override a failed bound check", async () => {
  const criterion = "add(2, 3) returns 5.";
  const command = `node --input-type=module -e 'import assert from "node:assert/strict"; import { add } from "./sum.mjs"; assert.equal(add(2, 3), 5)'`;
  for (const mode of ["unbound", "syntax-only", "failed-bound", "one-of-two-failed", "different-id", "passed-bound"] as const) {
    const { ws, spec, cleanup } = await makeWorkspace();
    try {
      const correct = ["one-of-two-failed", "different-id", "passed-bound"].includes(mode);
      await writeFile(path.join(ws, "sum.mjs"), `export const add = (a, b) => a ${correct ? "+" : "-"} b;\n`);
      const bound = { name: "addition", command, claims: { sum_correct: criterion } };
      const checks = mode === "unbound" ? [] : mode === "syntax-only" ? [{ name: "syntax", command: "node --check sum.mjs" }]
        : mode === "one-of-two-failed" ? [bound, { ...bound, name: "second", command: "exit 1" }] : [bound];
      const demo = createDemoMockHarness();
      const harness = new MockHarness({
        planner: (inv, api) => demo["scripts"].planner!(inv, api),
        developer: () => "Preserved the seeded sum implementation.",
        tester: async (_inv, api) => {
          const fake = await api.run("printf PASS");
          api.submit("submit_evidence", {
            qa_status: "pass", summary: "Every product behavior works.",
            verified_records: [{ claim_id: mode === "different-id" ? "unrelated_behavior" : "sum_correct",
              claim: "The application can send payments worldwide.",
              execution_records: [{ type: "check", path: fake.stdout_path, observation: "PASS" }] }],
            gap_records: [], planner_handoff: {},
            checks: [{ ...bound, status: "pass", exit_code: 0 }],
          });
        },
      });
      const result = await runHoh({ workspace: ws, specPath: spec, harness,
        config: { protocol: "paper", harness: "mock", claim_catalog: "off", loops: 1, checks } });
      const evidence = result.results[0].evidence;
      if (mode === "passed-bound") {
        assert.equal(evidence.qa_status, "pass");
        assert.equal(evidence.verified_records[0].claim, criterion, "QA cannot expand the predeclared meaning");
        assert.ok(evidence.verified_records[0].execution_records.some((r) => r.execution_id?.startsWith("check:") && r.path?.startsWith("checks/")));
      } else {
        assert.equal(evidence.qa_status, "fail", mode);
        assert.equal(evidence.verified_records.length, 0, mode);
        assert.ok(evidence.gap_records.some((record) => record.claim_id === (mode === "different-id" ? "unrelated_behavior" : "sum_correct")), mode);
      }
    } finally { await cleanup(); }
  }
});

test("check claim bindings reject malformed and conflicting criteria", () => {
  for (const claims of [null, [], { entry: "" }, { "Bad ID": "criterion" }]) {
    const config = mergeConfig(DEFAULT_CONFIG, { checks: [{ name: "check", command: "true", claims: claims as any }] });
    assert.ok(validateConfig(config).some((error) => error.includes("claims")));
  }
  const config = mergeConfig(DEFAULT_CONFIG, { checks: [
    { name: "one", command: "true", claims: { entry: "one" } },
    { name: "two", command: "true", claims: { entry: "two" } },
  ] });
  assert.ok(validateConfig(config).some((error) => error.includes("conflicts")));
});

test("a repaired unbound runtime check closes its own issue without verifying a product claim", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const demo = createDemoMockHarness();
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: (inv, api) => api.write("sum.mjs", inv.loopIndex === 1 ? "broken syntax {" : "export const add = (a, b) => a + b;\n"),
      tester: async (_inv, api) => {
        const fake = await api.run("printf PASS");
        api.submit("submit_evidence", { qa_status: "pass", summary: "Claimed product success.",
          verified_records: [{ claim_id: "sum_correct", claim: "All sums are correct.", execution_records: [{ type: "check", path: fake.stdout_path, observation: "PASS" }] }],
          gap_records: [], planner_handoff: {} });
      },
    });
    const result = await runHoh({ workspace: ws, specPath: spec, harness,
      config: { harness: "mock", claim_catalog: "off", loops: 2, checks: [{ name: "syntax", command: "node --check sum.mjs" }] } });
    for (const loop of result.results) {
      assert.equal(loop.evidence.qa_status, "fail");
      assert.deepEqual(loop.evidence.verified_records, []);
    }
    const ledger = await readJson<any>(new RunPaths(ws).ledger);
    assert.equal(ledger.issues["check.syntax"].status, "closed");
    assert.equal(ledger.issues["check.syntax"].closed_loop, 2);
    assert.equal(ledger.issues.sum_correct.status, "open");
  } finally { await cleanup(); }
});

test("paper QA rejects prose and forged file receipts without any executed test", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const demo = createDemoMockHarness();
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: (inv, api) => demo["scripts"].developer!(inv, api),
      tester: async (inv, api) => {
        await api.write(path.join(inv.evidenceDir!, "forged.log"), "all tests passed");
        api.submit("submit_evidence", {
          qa_status: "pass", summary: "The model claims it ran tests.",
          verified_records: [
            { claim_id: "main_entry", claim: "Entry works", execution_records: [{ type: "check", observation: "passed" }] },
            { claim_id: "player_control", claim: "Control works", execution_records: [{ type: "check", path: "forged.log", observation: "passed", execution_id: "fake", sha256: "fake" }] },
          ],
          executions: [{ id: "fake", exit_code: 0, command: "test", files: [{ path: "forged.log", sha256: "fake" }] }],
          gap_records: [], planner_handoff: {},
        });
      },
    });
    const result = await runHoh({ workspace: ws, specPath: spec, harness, config: { protocol: "paper", harness: "mock", loops: 1, checks: [] } });
    const evidence = result.results[0].evidence;
    assert.equal(evidence.qa_status, "fail");
    assert.deepEqual(evidence.verified_records, []);
    assert.deepEqual(evidence.executions, []);
    assert.equal(evidence.checks.length, 0);
    assert.equal(evidence.gap_records[1].execution_records[0].execution_id, undefined);
    const coverage = await readJson<any>(new RunPaths(ws).coverage);
    assert.equal(coverage.claims.main_entry.last_status, "gap");
  } finally { await cleanup(); }
});

test("the core loop runs without a catalog; explicit off ignores an invalid catalog", async () => {
  for (const mode of [undefined, "off"] as const) {
    const { ws, spec, cleanup } = await makeWorkspace();
    try {
      const paths = new RunPaths(ws);
      if (mode === "off") await writeFile(paths.claims, "invalid optional catalog");
      else await rm(paths.claims);
      const demo = createDemoMockHarness();
      const harness = new MockHarness({
        planner: (inv, api) => {
          assert.equal(inv.loopIndex, 1, "core must not invoke the optional generator");
          return demo["scripts"].planner!(inv, api);
        },
        developer: (inv, api) => demo["scripts"].developer!(inv, api),
        tester: (inv, api) => demo["scripts"].tester!(inv, api),
      });
      const result = await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1, claim_catalog: mode } });
      assert.equal(result.status, "completed");
      assert.equal(result.results[0].evidence.claim_catalog_sha256, null);
      assert.equal(await readJson(paths.coverage), null);
      if (!mode) assert.equal(await readJson(paths.claims), null);
    } finally { await cleanup(); }
  }
});

test("explicit catalog generation reports failure before development", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    await rm(new RunPaths(ws).claims);
    const harness = new MockHarness({ planner: () => "no valid claims" });
    await assert.rejects(runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1, claim_catalog: "generate" } }), /claim generation failed after 2 attempts/);
    assert.deepEqual(harness.calls.map((call) => call.loopIndex), [0, 0]);
  } finally { await cleanup(); }
});

test("failed HoH and vanilla Developers restore committed runtime forgeries and trusted transcripts", async () => {
  for (const condition of ["hoh", "vanilla"] as const) {
    const { ws, spec, cleanup } = await makeWorkspace();
    try {
      const paths = new RunPaths(ws);
      const demo = createDemoMockHarness();
      let originalConfig = "";
      const harness = new MockHarness({
        planner: (inv, api) => demo["scripts"].planner!(inv, api),
        developer: async (inv, api) => {
          originalConfig = await readFile(paths.config, "utf8");
          await api.write(paths.config, "forged config");
          await api.write(path.join(paths.root, "forged-runtime-record.json"), "forged");
          await api.write(paths.transcript(1, "developer"), "FORGED_TRANSCRIPT");
          inv.onTranscript?.('TRUSTED_PROCESS_EVENT\n');
          await git(["add", "-f", ".hoh"], inv.cwd);
          await git(["commit", "-qm", "role-owned forgery"], inv.cwd);
          throw new Error("fixture developer failure");
        },
      });
      await assert.rejects(runExperimentCondition({
        condition, workspace: ws, specPath: spec, harness,
        config: { harness: "mock", loops: 1, checks: [] },
        binding: { plan_sha256: "a".repeat(64), attempt_id: `failure-${condition}`, cell_id: `cell-${condition}` },
      }), /fixture developer failure/);
      assert.equal(await readJson(path.join(paths.root, "forged-runtime-record.json")), null);
      assert.equal(await readFile(paths.config, "utf8"), originalConfig);
      assert.equal(await readFile(paths.transcript(1, "developer"), "utf8"), "TRUSTED_PROCESS_EVENT\n");
      assert.doesNotMatch((await git(["log", "--format=%s"], ws)).stdout, /role-owned forgery/);
      assert.equal((await git(["cat-file", "-e", "HEAD:.hoh/forged-runtime-record.json"], ws, { allowFail: true })).code, 128);
      assert.equal((await readJson<any>(paths.errorJson(1))).message, "fixture developer failure");
    } finally { await cleanup(); }
  }
});

test("human checkpoint blocks Developer until approval and resumes the existing plan", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const harness = createDemoMockHarness();
    let reviews = 0;
    const options = { workspace: ws, specPath: spec, harness, config: { protocol: "extended" as const, harness: "mock" as const, loops: 1, human_checkpoint: true } };
    await assert.rejects(runHoh(options), /requires an approvePlan callback/);
    assert.equal(harness.calls.length, 0);
    await assert.rejects(runHoh({ ...options, approvePlan: async ({ document, documentPath }) => {
      reviews++;
      assert.equal(await readFile(documentPath, "utf8"), document);
      return false;
    } }), /declined at the human checkpoint/);
    assert.deepEqual(harness.calls.map((call) => call.role), ["planner"]);
    const result = await runHoh({ ...options, approvePlan: async () => { reviews++; return true; } });
    assert.equal(result.status, "completed");
    assert.equal(reviews, 2);
    assert.deepEqual(harness.calls.map((call) => call.role), ["planner", "developer", "tester"]);
    assert.equal((await readJson<any>(path.join(new RunPaths(ws).loopDir(1), "approval.json"))).approved, true);
    assert.ok(validateConfig(mergeConfig(DEFAULT_CONFIG, { protocol: "paper", human_checkpoint: true })).some((error) => error.includes("only in extended")));
  } finally { await cleanup(); }
});

test("approval reuse binds the current document and protocol, and cancellation records no approval", async () => {
  const { ws, cleanup } = await makeWorkspace();
  try {
    const documentPath = path.join(ws, "plan.md");
    const filename = path.join(ws, "approval.json");
    await writeFile(documentPath, "plan A");
    const checkpoint = { loopIndex: 1, document: "plan A", documentPath };
    let calls = 0;
    const approve = async () => { calls++; return true; };
    await requirePlanApproval(checkpoint, filename, "protocol A", approve);
    await requirePlanApproval(checkpoint, filename, "protocol A", approve);
    assert.equal(calls, 1);
    await requirePlanApproval(checkpoint, filename, "protocol B", approve);
    assert.equal(calls, 2);
    await writeFile(documentPath, "plan B");
    await assert.rejects(requirePlanApproval(checkpoint, filename, "protocol B", approve), /changed before human review/);
    await rm(filename);
    await assert.rejects(requirePlanApproval({ ...checkpoint, document: "plan B" }, filename, "protocol B", async () => {
      await writeFile(documentPath, "plan C");
      return true;
    }), /changed during human review/);
    const controller = new AbortController();
    await assert.rejects(requirePlanApproval({ ...checkpoint, document: "plan C", signal: controller.signal }, filename, "protocol B", async () => {
      controller.abort(new Error("stop approval"));
      return true;
    }), /stop approval/);
    assert.equal(await readJson(filename), null);
  } finally { await cleanup(); }
});
