import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createDemoMockHarness, MockHarness } from "../harness/mock.js";
import { bindEvidenceFiles } from "../runtime/evidence-files.js";
import { runCheck } from "../runtime/checks.js";
import { ExecutionEvidenceCapture } from "../runtime/execution-evidence.js";
import { git } from "../runtime/git.js";
import { runHoh } from "../runtime/loop.js";
import { readJson, RunPaths } from "../runtime/state.js";
import type { CheckResult, EvidenceBundle } from "../types.js";
import { makeWorkspace } from "./helpers.js";

function expectedTail(full: string): string {
  const limit = 4000;
  return full.length > limit ? `…(${full.length - limit} chars omitted)…\n${full.slice(-limit)}` : full;
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function repoPath(workspace: string, file: string): string {
  return path.relative(workspace, file).replaceAll(path.sep, "/");
}

async function readHeadFile(workspace: string, file: string): Promise<string> {
  return (await git(["show", `HEAD:${repoPath(workspace, file)}`], workspace)).stdout;
}

async function headHasFile(workspace: string, file: string): Promise<boolean> {
  return (await git(["cat-file", "-e", `HEAD:${repoPath(workspace, file)}`], workspace, { allowFail: true })).code === 0;
}

function evidenceBundle(overrides: Partial<EvidenceBundle>): EvidenceBundle {
  return {
    schema_version: 1,
    loop_index: 1,
    candidate_id: "candidate",
    claim_catalog_sha256: null,
    qa_status: "pass",
    summary: "Evidence binding fixture.",
    verified_records: [],
    gap_records: [],
    planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
    checks: [],
    candidate_source_sha256_before: "before",
    candidate_source_sha256_after: "before",
    frozen: true,
    runtime_notes: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0, duration_ms: 0 },
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

test("binding never upgrades failed QA and rebinds only usable evidence references", async () => {
  const { ws, cleanup } = await makeWorkspace();
  try {
    const evidenceDir = new RunPaths(ws).evidenceDir(1);
    const checkDir = path.join(evidenceDir, "checks");
    const checkPath = path.join(checkDir, "failed.log");
    const checkOutput = "trusted failure output\n";
    await mkdir(checkDir, { recursive: true });
    await writeFile(checkPath, checkOutput);

    const alreadyFailed = await bindEvidenceFiles(
      evidenceBundle({
        qa_status: "fail",
        verified_records: [
          {
            claim_id: "valid_run",
            claim: "A valid run was observed.",
            execution_records: [{ type: "run", observation: "ran" }],
            status: "verified",
          },
        ],
        checks: [
          {
            name: "no-output",
            command: "true",
            status: "pass",
            exit_code: 0,
            duration_ms: 1,
            stdout_tail: "",
            stderr_tail: "",
            stdout_sha256: "untrusted-submitted-hash",
          },
        ],
      }),
      evidenceDir,
    );
    assert.equal(alreadyFailed.qa_status, "fail");
    assert.equal(alreadyFailed.checks[0].stdout_sha256, undefined);

    const rebound = await bindEvidenceFiles(
      evidenceBundle({
        verified_records: [
          {
            claim_id: "unsafe_run",
            claim: "An unsafe path must not prove execution.",
            execution_records: [{ type: "run", path: "../outside.log", observation: "claimed" }],
            status: "verified",
            severity: "blocker",
          },
          {
            claim_id: "valid_run",
            claim: "A valid run was observed.",
            execution_records: [{ type: "run", observation: "ran" }],
            status: "verified",
          },
        ],
        checks: [
          {
            name: "failed-check",
            command: "false",
            status: "fail",
            exit_code: 1,
            duration_ms: 1,
            stdout_tail: checkOutput,
            stderr_tail: "",
            stdout_path: `evidence/checks/${path.basename(checkPath)}`,
            stdout_sha256: "untrusted-submitted-hash",
            stderr_sha256: "untrusted-submitted-hash",
          },
        ],
      }),
      evidenceDir,
    );

    assert.equal(rebound.qa_status, "fail");
    assert.deepEqual(rebound.verified_records, []);
    assert.ok(rebound.gap_records.some((record) => record.claim_id === "valid_run"));
    const unsafeGap = rebound.gap_records.find((record) => record.claim_id === "unsafe_run");
    assert.equal(unsafeGap?.severity, "blocker");
    assert.ok(rebound.runtime_notes.some((note) => note.includes("outside HOH_EVIDENCE_DIR")));
    assert.equal(rebound.checks[0].stdout_path, "checks/failed.log");
    assert.equal(rebound.checks[0].stdout_sha256, createHash("sha256").update(checkOutput).digest("hex"));
    assert.equal(rebound.checks[0].stderr_sha256, undefined);
  } finally {
    await cleanup();
  }
});

test("bound checks require successful execution and unchanged output files", async () => {
  const { ws, cleanup } = await makeWorkspace();
  try {
    const directory = new RunPaths(ws).evidenceDir(1);
    await mkdir(directory, { recursive: true });
    const check = await runCheck({ name: "real", command: "printf observed", claims: { entry: "observed" } }, ws, 10_000, {}, { directory, basename: "real" });
    const failed = await runCheck({ name: "failed", command: "printf failure; exit 1", claims: { entry: "observed" } }, ws, 10_000, {}, { directory, basename: "failed" });
    await writeFile(path.join(directory, "unrelated.log"), "claimed");
    const candidate = (file: string, checks: CheckResult[] = []): EvidenceBundle => evidenceBundle({
      checks,
      verified_records: [{ claim_id: "entry", claim: "observed", status: "verified", execution_records: [{ type: "check", path: file, observation: "observed" }] }],
    });
    const executions = [check.execution!, failed.execution!];
    const verified = await bindEvidenceFiles(candidate(check.stdout_path!, [check]), directory, undefined, executions);
    assert.equal(verified.qa_status, "pass");
    assert.equal(verified.verified_records[0].execution_records[0].execution_id, check.execution!.id);
    for (const file of [failed.stdout_path!, "unrelated.log"]) {
      const rejected = await bindEvidenceFiles(candidate(file, [failed]), directory, undefined, executions);
      assert.equal(rejected.qa_status, "fail");
      assert.equal(rejected.verified_records.length, 0);
    }
    await writeFile(path.join(directory, check.stdout_path!), "changed after execution");
    assert.equal((await bindEvidenceFiles(candidate(check.stdout_path!, [check]), directory, undefined, executions)).qa_status, "fail");
  } finally { await cleanup(); }
});

test("evidence root links never expose their target to retention cleanup", async () => {
  const { ws, cleanup } = await makeWorkspace();
  try {
    const target = path.join(ws, "target");
    const directory = path.join(ws, "evidence");
    await mkdir(target);
    const contents = "x".repeat(2 * 1024 * 1024 + 1);
    await writeFile(path.join(target, "outside.log"), contents);
    await symlink(target, directory);
    await bindEvidenceFiles(evidenceBundle({}), directory);
    assert.equal(await readFile(path.join(target, "outside.log"), "utf8"), contents);
    assert.equal((await lstat(directory)).isDirectory(), true);
  } finally { await cleanup(); }
});

test("a claim downgraded during file binding wins over another verified record with the same ID", async () => {
  const { ws, cleanup } = await makeWorkspace();
  try {
    const directory = new RunPaths(ws).evidenceDir(1);
    await mkdir(directory, { recursive: true });
    const check = await runCheck({ name: "scene", command: "printf checked", claims: { scene: "The registered scene check passes." } }, ws, 10_000, {}, { directory });
    const capture = new ExecutionEvidenceCapture(directory);
    capture.start("qa:screenshot", "capture fixture");
    await writeFile(path.join(directory, "present.png"), "fixture image bytes");
    capture.end("qa:screenshot", 0);
    const bundle = evidenceBundle({ checks: [check], verified_records: ["present.png", "missing.png"].map((file) => ({
      claim_id: "scene", claim: "The registered scene check passes.", status: "verified",
      execution_records: [{ type: "screenshot", path: file, observation: "image captured" }],
    })) });
    const result = await bindEvidenceFiles(bundle, directory, { schema_version: 1, spec_sha256: "a".repeat(64),
      claims: [{ id: "scene", criterion: "The registered scene check passes.", requires: ["screenshot"] }] }, capture.executions);
    assert.equal(result.qa_status, "fail");
    assert.deepEqual(result.verified_records, []);
    assert.ok(result.gap_records.some((record) => record.claim_id === "scene"));
  } finally { await cleanup(); }
});

test("capture and retention prioritize check evidence at the loop byte limit", async () => {
  const { ws, cleanup } = await makeWorkspace();
  try {
    const directory = path.join(ws, "evidence");
    const capture = new ExecutionEvidenceCapture(directory);
    capture.start("real-process", "fixture evidence producer");
    await mkdir(path.join(directory, "aaa"), { recursive: true });
    await mkdir(path.join(directory, "checks"));
    for (let i = 0; i < 15; i++) await writeFile(path.join(directory, "aaa", `${i}.log`), "x".repeat(2 * 1024 * 1024));
    await writeFile(path.join(directory, "checks", "result.log"), "checked");
    capture.end("real-process", 0);
    const bundle = evidenceBundle({ verified_records: [{ claim_id: "entry", claim: "observed", status: "verified", execution_records: [{ type: "check", path: "checks/result.log", observation: "observed" }] }] });
    const result = await bindEvidenceFiles(bundle, directory, undefined, capture.executions);
    assert.equal(result.qa_status, "fail", "retained execution provenance alone does not verify an unbound claim");
    assert.ok(result.gap_records[0].execution_records[0].sha256);
    assert.ok(capture.executions[0].files.some((file) => file.path === "checks/result.log"));
  } finally { await cleanup(); }
});

test("tester evidence files are force-added while out-of-scope writes are blocked", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    await writeFile(path.join(ws, ".gitignore"), "*.log\n");
    const demo = createDemoMockHarness();
    const fileContent = "tester-collected evidence\n";
    const paths = new RunPaths(ws);
    const evidenceDir = paths.evidenceDir(1);
    const outsidePath = path.join(paths.loopDir(1), "evidence-evil", "outside.log");
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: (inv, api) => demo["scripts"].developer!(inv, api),
      tester: async (_inv, api) => {
        assert.equal(process.env.HOH_EVIDENCE_DIR, evidenceDir);
        assert.equal((await stat(evidenceDir)).isDirectory(), true);

        await api.run('mkdir -p "$HOH_EVIDENCE_DIR/tester" && printf "tester-collected evidence\\n" > "$HOH_EVIDENCE_DIR/tester/observed.log"');
        await api.write(outsidePath, "outside evidence root\n");
        api.submit("submit_evidence", {
          qa_status: "pass",
          summary: "A tester-created evidence file was collected.",
          verified_records: [
            {
              claim_id: "free_evidence_file_claim",
              claim: "The tester can preserve and cite collected evidence.",
              execution_records: [
                { type: "log", path: "tester/observed.log", observation: "The collected file exists." },
                { type: "log", path: "missing/ghost.log", observation: "The submitted path does not exist." },
                { type: "log", path: "../evidence-evil/outside.log", observation: "The submitted path escapes the evidence directory." },
              ],
            },
          ],
          gap_records: [],
          planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
        });
      },
    });

    await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } });
    const storedFile = path.join(evidenceDir, "tester", "observed.log");
    assert.equal(await readFile(storedFile, "utf8"), fileContent);
    assert.equal(await readHeadFile(ws, storedFile), fileContent);
    assert.equal(await exists(outsidePath), false);
    assert.equal(await headHasFile(ws, outsidePath), false);
    assert.equal((await git(["diff", "--cached", "--quiet"], ws, { allowFail: true })).code, 0);
    assert.equal(await exists(path.join(evidenceDir, "missing", "ghost.log")), false);

    const evidence = (await readJson<EvidenceBundle>(paths.evidenceJson(1)))!;
    assert.equal(evidence.qa_status, "fail");
    const claim = evidence.gap_records.find((record) => record.claim_id === "free_evidence_file_claim");
    assert.ok(claim);
    const records = claim.execution_records;
    const valid = records.find((record) => record.path === "tester/observed.log");
    const missing = records.find((record) => record.path === "missing/ghost.log");
    const outside = records.find((record) => record.path === "../evidence-evil/outside.log");
    assert.ok(valid);
    assert.ok(missing);
    assert.ok(outside);
    assert.equal(valid.path, "tester/observed.log");
    assert.equal(path.isAbsolute(valid.path), false);
    assert.ok(!valid.path.split(/[\\/]/).includes(".."));
    assert.equal(valid.sha256, createHash("sha256").update(fileContent).digest("hex"));
    assert.equal(missing.sha256, undefined);
    assert.equal(outside.sha256, undefined);
    assert.ok(evidence.runtime_notes.some((note) => note.includes("missing/ghost.log")), JSON.stringify(evidence.runtime_notes));
    assert.ok(
      evidence.runtime_notes.some((note) => note.includes("outside HOH_EVIDENCE_DIR") && note.includes("../evidence-evil/outside.log")),
      JSON.stringify(evidence.runtime_notes),
    );
    const mutationGap = evidence.gap_records.find((record) => record.claim_id === "runtime.workspace_mutated_by_tester");
    assert.equal(mutationGap?.severity, "blocker");
    assert.ok(mutationGap?.execution_records[0].observation.includes(repoPath(ws, outsidePath)));
  } finally {
    await cleanup();
  }
});

test("deterministic checks preserve full stdout and stderr while keeping CheckResult tails", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    await writeFile(path.join(ws, ".gitignore"), "*.log\n");
    const stdout = `stdout-begin\n${"o".repeat(5000)}\nstdout-end\n`;
    const stderr = `stderr-begin\n${"e".repeat(5000)}\nstderr-end\n`;
    const evidenceDir = new RunPaths(ws).evidenceDir(1);
    const command =
      `test "$HOH_EVIDENCE_DIR" = ${JSON.stringify(evidenceDir)} && test -d "$HOH_EVIDENCE_DIR" && ${JSON.stringify(process.execPath)} -e 'process.stdout.write("stdout-begin\\n"+"o".repeat(5000)+"\\nstdout-end\\n");process.stderr.write("stderr-begin\\n"+"e".repeat(5000)+"\\nstderr-end\\n")'`;

    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness: createDemoMockHarness(),
      config: { harness: "mock", loops: 1, checks: [{ name: "long-output", command }] },
    });

    const check = result.results[0].evidence.checks.find((record) => record.name === "long-output");
    assert.ok(check);
    assert.equal(check.status, "pass");
    assert.equal(check.stdout_tail, expectedTail(stdout));
    assert.equal(check.stderr_tail, expectedTail(stderr));

    assert.ok(check.stdout_path);
    assert.ok(check.stderr_path);
    assert.equal(path.isAbsolute(check.stdout_path), false);
    assert.equal(path.isAbsolute(check.stderr_path), false);
    assert.ok(!check.stdout_path.split(/[\\/]/).includes(".."));
    assert.ok(!check.stderr_path.split(/[\\/]/).includes(".."));
    assert.notEqual(check.stdout_path, check.stderr_path);
    assert.equal(await readFile(path.join(evidenceDir, check.stdout_path), "utf8"), stdout);
    assert.equal(await readFile(path.join(evidenceDir, check.stderr_path), "utf8"), stderr);
    assert.equal(check.stdout_sha256, createHash("sha256").update(stdout).digest("hex"));
    assert.equal(check.stderr_sha256, createHash("sha256").update(stderr).digest("hex"));
    assert.equal(await readHeadFile(ws, path.join(evidenceDir, check.stdout_path)), stdout);
    assert.equal(await readHeadFile(ws, path.join(evidenceDir, check.stderr_path)), stderr);
  } finally {
    await cleanup();
  }
});

test("a fixed visual claim with only a missing screenshot is downgraded", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const paths = new RunPaths(ws);
    const specContent = await readFile(spec, "utf8");
    await writeFile(
      paths.claims,
      `${JSON.stringify(
        {
          schema_version: 1,
          spec_sha256: createHash("sha256").update(specContent).digest("hex"),
          claims: [{ id: "visual_result", criterion: "The result is visibly distinct.", requires: ["screenshot"] }],
        },
        null,
        2,
      )}\n`,
    );
    const demo = createDemoMockHarness();
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: (inv, api) => demo["scripts"].developer!(inv, api),
      tester: (_inv, api) => {
        api.submit("submit_evidence", {
          qa_status: "pass",
          summary: "The visual result was claimed from an unavailable screenshot.",
          verified_records: [
            {
              claim_id: "visual_result",
              claim: "The result is visibly distinct.",
              execution_records: [{ type: "screenshot", path: "missing.png", observation: "The screenshot was not actually saved." }],
            },
          ],
          gap_records: [],
          planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
        });
      },
    });

    const result = await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } });
    const evidence = result.results[0].evidence;
    assert.equal(evidence.qa_status, "fail");
    assert.ok(!evidence.verified_records.some((record) => record.claim_id === "visual_result"));
    const gap = evidence.gap_records.find((record) => record.claim_id === "visual_result");
    assert.equal(gap?.status, "gap");
    assert.equal(gap?.severity, "minor");
    assert.equal(gap?.execution_records[0].sha256, undefined);
    assert.ok(evidence.runtime_notes.some((note) => note.includes("evidence file not found: missing.png")));
    assert.ok(evidence.runtime_notes.some((note) => note.includes("required types screenshot") && note.includes("downgraded to gap")));
  } finally {
    await cleanup();
  }
});

test("evidence symlinks and files over 2 MiB are removed without hashes", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const paths = new RunPaths(ws);
    const evidenceDir = paths.evidenceDir(1);
    const linkedPath = path.join(evidenceDir, "linked.png");
    const oversizedPath = path.join(evidenceDir, "too-big.log");
    const targetPath = path.join(evidenceDir, "target.txt");
    const demo = createDemoMockHarness();
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: (inv, api) => demo["scripts"].developer!(inv, api),
      tester: async (_inv, api) => {
        await api.write(targetPath, "safe target\n");
        await symlink("target.txt", linkedPath);
        await api.write(oversizedPath, "x".repeat(2 * 1024 * 1024 + 1));
        const check = await api.run('test -f "$HOH_EVIDENCE_DIR/target.txt"');
        api.submit("submit_evidence", {
          qa_status: "pass",
          summary: "Unsafe evidence entries were submitted alongside a runtime observation.",
          verified_records: [
            {
              claim_id: "bounded_evidence_files",
              claim: "Only bounded regular evidence files are retained.",
              execution_records: [
                { type: "run", path: check.stdout_path, observation: "The retained target file exists." },
                { type: "screenshot", path: "linked.png", observation: "A symlink was submitted as a screenshot." },
                { type: "log", path: "too-big.log", observation: "An oversized log was submitted." },
              ],
            },
          ],
          gap_records: [],
          planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
        });
      },
    });

    const result = await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } });
    const evidence = result.results[0].evidence;
    assert.equal(evidence.qa_status, "fail", "file retention does not independently verify a behavior");
    assert.equal(await exists(linkedPath), false);
    assert.equal(await exists(oversizedPath), false);
    assert.equal(await headHasFile(ws, linkedPath), false);
    assert.equal(await headHasFile(ws, oversizedPath), false);
    assert.equal((await git(["diff", "--cached", "--quiet"], ws, { allowFail: true })).code, 0);
    assert.equal(await readFile(targetPath, "utf8"), "safe target\n");
    const claim = evidence.gap_records.find((record) => record.claim_id === "bounded_evidence_files");
    assert.ok(claim);
    assert.equal(claim.execution_records.find((record) => record.path === "linked.png")?.sha256, undefined);
    assert.equal(claim.execution_records.find((record) => record.path === "too-big.log")?.sha256, undefined);
    assert.ok(evidence.runtime_notes.some((note) => note.includes("symbolic link") && note.includes("linked.png")));
    assert.ok(evidence.runtime_notes.some((note) => note.includes("file limit") && note.includes("too-big.log")));
  } finally {
    await cleanup();
  }
});

test("tester edits to runtime records and frozen check logs are restored and blocked", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const paths = new RunPaths(ws);
    const checkLog = path.join(paths.evidenceDir(1), "checks", "01-tamper-check.stdout.log");
    let originalConfig = "";
    let originalCheckLog = "";
    const demo = createDemoMockHarness();
    const harness = new MockHarness({
      planner: (inv, api) => demo["scripts"].planner!(inv, api),
      developer: (inv, api) => demo["scripts"].developer!(inv, api),
      tester: async (_inv, api) => {
        originalConfig = await readFile(paths.config, "utf8");
        originalCheckLog = await readFile(checkLog, "utf8");
        await api.write(paths.config, "tampered config\n");
        await api.write(checkLog, "tampered check output\n");
        api.submit("submit_evidence", {
          qa_status: "pass",
          summary: "The tester attempted to alter frozen runtime records.",
          verified_records: [
            {
              claim_id: "free_runtime_claim",
              claim: "A runtime behavior was observed.",
              execution_records: [{ type: "run", observation: "The behavior ran." }],
            },
          ],
          gap_records: [],
          planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
        });
      },
    });
    const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write("trusted check output\\n")'`;

    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness,
      config: { harness: "mock", loops: 1, checks: [{ name: "tamper-check", command }] },
    });
    const evidence = result.results[0].evidence;
    assert.equal(await readFile(paths.config, "utf8"), originalConfig);
    assert.equal(await readFile(checkLog, "utf8"), originalCheckLog);
    assert.equal(originalCheckLog, "trusted check output\n");
    assert.equal(await readHeadFile(ws, paths.config), originalConfig);
    assert.equal(await readHeadFile(ws, checkLog), originalCheckLog);
    assert.equal((await git(["diff", "--cached", "--quiet"], ws, { allowFail: true })).code, 0);
    assert.equal(evidence.qa_status, "fail");
    assert.ok(!evidence.verified_records.some((record) => record.claim_id === "free_runtime_claim"));
    assert.ok(evidence.gap_records.some((record) => record.claim_id === "free_runtime_claim"));
    const check = evidence.checks.find((record) => record.name === "tamper-check");
    assert.equal(check?.status, "pass");
    assert.equal(check?.stdout_tail, originalCheckLog);
    assert.equal(check?.stdout_sha256, createHash("sha256").update(originalCheckLog).digest("hex"));
    assert.equal(check?.stdout_path, repoPath(paths.evidenceDir(1), checkLog));
    const mutationGap = evidence.gap_records.find((record) => record.claim_id === "runtime.workspace_mutated_by_tester");
    assert.equal(mutationGap?.severity, "blocker");
    assert.ok(mutationGap?.execution_records[0].observation.includes(repoPath(ws, paths.config)));
    assert.ok(mutationGap?.execution_records[0].observation.includes(repoPath(ws, checkLog)));
  } finally {
    await cleanup();
  }
});
