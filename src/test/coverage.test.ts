import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createDemoMockHarness } from "../harness/mock.js";
import {
  applyCoverage,
  claimCatalogSha256,
  coverageSummary,
  emptyCoverage,
  loadCoverage,
  makeClaimCatalog,
  rebuildCoverage,
} from "../runtime/coverage.js";
import { gitLog } from "../runtime/git.js";
import { runHoh } from "../runtime/loop.js";
import { readJson, RunPaths } from "../runtime/state.js";
import type { ClaimRecord, CoverageState, EvidenceBundle } from "../types.js";
import { DEMO_CHECKS, DEMO_CLAIMS, DEMO_SPEC, makeWorkspace } from "./helpers.js";

const execFileAsync = promisify(execFile);

function bundle(loop: number, verifiedIds: string[], gapIds: string[], catalog = makeClaimCatalog(DEMO_SPEC, DEMO_CLAIMS)): EvidenceBundle {
  const record = (claim_id: string, status: ClaimRecord["status"]): ClaimRecord => ({
    claim_id,
    claim: `${claim_id} criterion`,
    execution_records: [],
    status,
  });
  return {
    schema_version: 1,
    loop_index: loop,
    candidate_id: `loop-${loop}`,
    claim_catalog_sha256: claimCatalogSha256(catalog),
    qa_status: gapIds.length ? "partial" : "pass",
    summary: "fixture",
    verified_records: verifiedIds.map((id) => record(id, "verified")),
    gap_records: gapIds.map((id) => record(id, "gap")),
    planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
    checks: [],
    candidate_source_sha256_before: "a".repeat(64),
    candidate_source_sha256_after: "a".repeat(64),
    frozen: true,
    runtime_notes: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0, duration_ms: 0 },
    created_at: new Date(0).toISOString(),
  };
}

test("coverage: fixed claims transition independently across loops", () => {
  const catalog = makeClaimCatalog(DEMO_SPEC, DEMO_CLAIMS);
  let coverage = emptyCoverage(catalog);
  assert.deepEqual(coverageSummary(catalog, coverage), { verified: 0, gap: 0, untested: 3, all: 3 });

  coverage = applyCoverage(catalog, coverage, bundle(1, ["main_entry"], ["result_state"]));
  assert.deepEqual(coverageSummary(catalog, coverage), { verified: 1, gap: 1, untested: 1, all: 3 });
  assert.deepEqual(coverage.claims.main_entry, { last_status: "verified", last_verified_loop: 1, verified_count: 1 });
  assert.equal(coverage.claims.player_control.last_status, "untested");

  coverage = applyCoverage(catalog, coverage, bundle(2, ["player_control", "result_state"], []));
  assert.deepEqual(coverageSummary(catalog, coverage), { verified: 2, gap: 0, untested: 1, all: 3 });
  assert.deepEqual(coverage.claims.result_state, { last_status: "verified", last_verified_loop: 2, verified_count: 1 });
  assert.deepEqual(coverage.claims.main_entry, { last_status: "untested", last_verified_loop: 1, verified_count: 1 });

  coverage = applyCoverage(catalog, coverage, bundle(2, ["player_control", "result_state"], []));
  assert.equal(coverage.claims.result_state.verified_count, 1, "reapplying one loop must not inflate the count");
});

test("coverage: replay ignores aliases and evidence bound to an edited catalog", async () => {
  const { ws, cleanup } = await makeWorkspace();
  try {
    const paths = new RunPaths(ws);
    const catalog = makeClaimCatalog(DEMO_SPEC, DEMO_CLAIMS);
    await mkdir(paths.loopDir(1), { recursive: true });
    await writeFile(paths.evidenceJson(1), `${JSON.stringify(bundle(1, ["main_entry"], []), null, 2)}\n`);
    await mkdir(path.join(paths.iterations, "loop-1"), { recursive: true });

    const rebuilt = await rebuildCoverage(paths, catalog);
    assert.equal(rebuilt.claims.main_entry.verified_count, 1);
    await writeFile(paths.coverage, `${JSON.stringify(rebuilt, null, 2)}\n`);

    const edited = makeClaimCatalog(DEMO_SPEC, DEMO_CLAIMS.map((claim) =>
      claim.id === "main_entry" ? { ...claim, criterion: "A different meaning under the same id." } : claim,
    ));
    assert.deepEqual(coverageSummary(edited, await loadCoverage(paths, edited)), {
      verified: 0,
      gap: 0,
      untested: 3,
      all: 3,
    });
    assert.deepEqual(coverageSummary(edited, await rebuildCoverage(paths, edited)), {
      verified: 0,
      gap: 0,
      untested: 3,
      all: 3,
    });
  } finally {
    await cleanup();
  }
});

test("coverage: two-loop run updates files, prompts, README, and status", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const harness = createDemoMockHarness();
    await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 2, checks: DEMO_CHECKS } });
    const paths = new RunPaths(ws);
    const coverage = (await readJson<CoverageState>(paths.coverage))!;
    assert.deepEqual(coverageSummary(makeClaimCatalog(DEMO_SPEC, DEMO_CLAIMS), coverage), { verified: 3, gap: 0, untested: 0, all: 3 });
    assert.deepEqual(coverage.claims.result_state, { last_status: "verified", last_verified_loop: 2, verified_count: 1 });

    const plannerPrompt = harness.calls.find((call) => call.role === "planner" && call.loopIndex === 1)!.prompt;
    const testerPrompt = harness.calls.find((call) => call.role === "tester" && call.loopIndex === 1)!.prompt;
    assert.match(plannerPrompt, /Fixed PRD claim coverage/);
    assert.match(plannerPrompt, /`result_state` \| untested \| check/);
    assert.match(testerPrompt, /Reuse its exact id/);
    assert.match(testerPrompt, /`result_state` \| untested \| check/);

    assert.match(await readFile(paths.readme, "utf8"), /Verified 3 \/ Untested 0 \/ Gap 0 \/ All 3/);
    const cli = path.resolve("dist/cli.js");
    const { stdout } = await execFileAsync(process.execPath, [cli, "status", "--workspace", ws]);
    assert.match(stdout, /Coverage: verified 3, untested 0, gap 0, all 3/);
  } finally {
    await cleanup();
  }
});

test("init-claims CLI drafts an editable catalog without starting a run", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const paths = new RunPaths(ws);
    await rm(paths.claims);
    const cli = path.resolve("dist/cli.js");
    const config = path.resolve("examples/mock.config.json");
    const { stdout } = await execFileAsync(process.execPath, [cli, "init-claims", "--workspace", ws, "--spec", spec, "--config", config]);
    assert.match(stdout, /Initialized 3 fixed claim\(s\)/);
    assert.equal((await readJson<any>(paths.claims))?.claims.length, 3);
    assert.deepEqual(coverageSummary(makeClaimCatalog(DEMO_SPEC, DEMO_CLAIMS), (await readJson<CoverageState>(paths.coverage))!), {
      verified: 0,
      gap: 0,
      untested: 3,
      all: 3,
    });
    await stat(paths.claimsTranscript);
    assert.equal((await gitLog(ws))[0].subject, "chore(hoh): initialize fixed PRD claims");
    assert.equal(await readJson(paths.runJson), null);
  } finally {
    await cleanup();
  }
});

test("explicit generation drafts missing fixed claims before the first planner loop", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const paths = new RunPaths(ws);
    await rm(paths.claims);
    const harness = createDemoMockHarness();
    await runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1, claim_catalog: "generate", checks: DEMO_CHECKS } });

    assert.equal(harness.calls[0].role, "planner");
    assert.equal(harness.calls[0].loopIndex, 0);
    assert.match(harness.calls[0].prompt, /Fixed PRD claim drafting/);
    assert.equal((await readJson<any>(paths.claims))?.claims.length, 3);
    assert.deepEqual(coverageSummary(makeClaimCatalog(DEMO_SPEC, DEMO_CLAIMS), (await readJson<CoverageState>(paths.coverage))!), {
      verified: 2,
      gap: 1,
      untested: 0,
      all: 3,
    });
  } finally {
    await cleanup();
  }
});
