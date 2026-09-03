import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_INLINE_CANDIDATE_DIFF_BYTES, type CandidateDiffBundle } from "../runtime/candidate-diff.js";
import { CONTEXT_POLICY } from "../runtime/context-policy.js";
import { emptyCoverage, makeClaimCatalog, renderCoveragePriorityIndex } from "../runtime/coverage.js";
import { emptyLedger } from "../runtime/ledger.js";
import {
  assertRolePromptWithinLimit,
  MAX_CONTEXT_INDEX_BYTES,
  MAX_INLINE_CONTEXT_BYTES,
  MAX_ROLE_PROMPT_BYTES,
  renderContextDisclosure,
  renderDevelopmentDocument,
  renderDeveloperPrompts,
  renderPlannerPrompts,
  renderTesterPrompts,
} from "../runtime/prompts.js";
import type { CheckResult, CoverageState, EvidenceBundle, Ledger } from "../types.js";
import { DEMO_CLAIMS, DEMO_SPEC } from "./helpers.js";

const candidateDiff: CandidateDiffBundle = {
  baseCommit: "a".repeat(40),
  candidateCommit: "b".repeat(40),
  changedFileCount: 1,
  mode: "full",
  inline: "### Changed files\n\"game/main.txt\"",
  inspectCommand: "git --no-pager diff 'base..candidate' -- ':(top,literal)game'",
};

const checks: CheckResult[] = [
  { name: "build", command: "npm run build", status: "pass", exit_code: 0, duration_ms: 25, stdout_tail: "ok", stderr_tail: "" },
];

function evidence(summary = "The candidate was exercised."): EvidenceBundle {
  return {
    schema_version: 1,
    loop_index: 1,
    candidate_id: "loop-01-fixture",
    claim_catalog_sha256: null,
    qa_status: "partial",
    summary,
    verified_records: [],
    gap_records: [],
    planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
    checks,
    candidate_source_sha256_before: "c".repeat(64),
    candidate_source_sha256_after: "c".repeat(64),
    frozen: true,
    runtime_notes: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 1, duration_ms: 1 },
    created_at: new Date(0).toISOString(),
  };
}

test("context policy owns the established disclosure and prompt byte limits", () => {
  assert.equal(Object.isFrozen(CONTEXT_POLICY), true);
  assert.deepEqual(CONTEXT_POLICY, {
    maxInlineContextBytes: 8 * 1024,
    maxContextIndexBytes: 4 * 1024,
    maxInlineCandidateDiffBytes: 32 * 1024,
    maxRolePromptBytes: 96 * 1024,
  });
  assert.equal(MAX_INLINE_CONTEXT_BYTES, CONTEXT_POLICY.maxInlineContextBytes);
  assert.equal(MAX_CONTEXT_INDEX_BYTES, CONTEXT_POLICY.maxContextIndexBytes);
  assert.equal(MAX_INLINE_CANDIDATE_DIFF_BYTES, CONTEXT_POLICY.maxInlineCandidateDiffBytes);
  assert.equal(MAX_ROLE_PROMPT_BYTES, CONTEXT_POLICY.maxRolePromptBytes);
});

test("context disclosure keeps small exact content and omits oversized content", () => {
  const small = "# Small\n\nExact fixture contents.";
  const inline = renderContextDisclosure({ sourcePath: ".hoh/spec.md", content: small, index: "- line 1: # Small" });
  assert.match(inline, /Canonical source: `\.hoh\/spec\.md`/);
  assert.ok(inline.indexOf("Canonical source") < inline.indexOf("Bounded index"));
  assert.ok(inline.indexOf("Bounded index") < inline.indexOf("BEGIN EXACT VIEW"));
  assert.ok(inline.includes(small));

  const exactLimit = "x".repeat(MAX_INLINE_CONTEXT_BYTES);
  const inclusive = renderContextDisclosure({ sourcePath: ".hoh/spec.md", content: exactLimit, index: "- exact limit" });
  assert.match(inclusive, /exact view inline/);
  assert.ok(inclusive.includes(exactLimit));

  const sentinel = "OVERSIZED_PRIVATE_BODY_SENTINEL";
  const large = `${exactLimit}${sentinel}`;
  const index = "i".repeat(MAX_CONTEXT_INDEX_BYTES * 2);
  const omitted = renderContextDisclosure({ sourcePath: ".hoh/spec.md", content: large, index });
  assert.match(omitted, /index only/);
  assert.match(omitted, /`\.hoh\/spec\.md`/);
  assert.doesNotMatch(omitted, new RegExp(sentinel));
  const renderedIndex = omitted.split("### Bounded index\n\n")[1].split("\n\n_Exact view omitted")[0];
  assert.ok(Buffer.byteLength(renderedIndex, "utf8") <= MAX_CONTEXT_INDEX_BYTES);
});

test("coverage priority index orders gaps, never-tested, stale, then recent", () => {
  const catalog = makeClaimCatalog("fixture", [
    { id: "recent", criterion: "recent", requires: [] },
    { id: "never", criterion: "never", requires: [] },
    { id: "gap", criterion: "gap", requires: [] },
    { id: "stale", criterion: "stale", requires: [] },
  ]);
  const coverage: CoverageState = {
    schema_version: 1,
    claim_catalog_sha256: "fixture",
    claims: {
      recent: { last_status: "verified", last_verified_loop: 9, verified_count: 2 },
      never: { last_status: "untested", last_verified_loop: null, verified_count: 0 },
      gap: { last_status: "gap", last_verified_loop: 7, verified_count: 1 },
      stale: { last_status: "untested", last_verified_loop: 2, verified_count: 1 },
    },
  };
  const index = renderCoveragePriorityIndex(catalog, coverage);
  assert.ok(index.indexOf("`gap`") < index.indexOf("`never`"));
  assert.ok(index.indexOf("`never`") < index.indexOf("`stale`"));
  assert.ok(index.indexOf("`stale`") < index.indexOf("`recent`"));
  assert.match(index, /`stale` \| untested .*\| stale \|/);
  assert.match(index, /`recent` \| verified .*\| recent \|/);
  assert.ok(Buffer.byteLength(index, "utf8") <= MAX_CONTEXT_INDEX_BYTES);
});

test("role prompts expose only their progressive context contract", async () => {
  const catalog = makeClaimCatalog(DEMO_SPEC, DEMO_CLAIMS);
  const coverage = emptyCoverage(catalog);
  const ledger: Ledger = emptyLedger();
  ledger.issues.hidden_from_tester = {
    id: "hidden_from_tester",
    claim: "TESTER_LEDGER_SENTINEL",
    status: "open",
    severity: "major",
    first_seen_loop: 1,
    last_seen_loop: 1,
    consecutive_gap_loops: 1,
    reopen_count: 0,
    history: [{ loop: 1, status: "open" }],
  };
  ledger.issues.mandatory_from_planner = {
    id: "mandatory_from_planner",
    claim: "MANDATORY_PLANNER_SENTINEL",
    status: "open",
    severity: "blocker",
    first_seen_loop: 1,
    last_seen_loop: 1,
    consecutive_gap_loops: 1,
    reopen_count: 0,
    recommended_update: "Repair this before discretionary work.",
    history: [{ loop: 1, status: "open" }],
  };

  const plannerEvidence = evidence();
  (plannerEvidence as EvidenceBundle & { external_evaluator?: string }).external_evaluator = "EXTERNAL_EVALUATOR_SENTINEL";
  const planner = await renderPlannerPrompts({
    loopIndex: 2,
    cwd: "/workspace",
    artifactDir: "game",
    specPath: ".hoh/spec.md",
    spec: DEMO_SPEC,
    baseCandidateId: "loop-01-fixture",
    previousEvidence: plannerEvidence,
    previousChecks: checks,
    ledger,
    claimCatalog: catalog,
    coverage,
  });
  assert.match(planner.user, /Canonical source: `\.hoh\/spec\.md`/);
  assert.match(planner.user, /Canonical source: `\.hoh\/iterations\/loop-01\/evidence\.json`/);
  assert.match(planner.user, /Canonical source: `\.hoh\/ledger\.json`/);
  assert.match(planner.user, /\*\*MANDATORY\*\* `mandatory_from_planner`.*MANDATORY_PLANNER_SENTINEL.*Repair this before discretionary work/);
  assert.match(planner.user, /`result_state` \| untested \| check/);
  assert.doesNotMatch(planner.user, /EXTERNAL_EVALUATOR_SENTINEL/);

  const developerSpec = "# Public specification\n\nPUBLIC_SPEC_SENTINEL";
  const developmentDocument = renderDevelopmentDocument({
    loopIndex: 2,
    baseCandidateId: "loop-01-fixture",
    overlay: {
      objective: "Repair the mandatory blocker",
      priorities: [{ name: "Repair", action: "Repair the blocker", observable_outcome: "The blocker is resolved" }],
      preservation_gate: [],
      acceptance_gate: ["The blocker has executable evidence"],
    },
    previousEvidence: plannerEvidence,
    ledger,
    previousChecks: checks,
  });
  const developer = await renderDeveloperPrompts({
    loopIndex: 2,
    cwd: "/workspace",
    artifactDir: "game",
    specPath: ".hoh/spec.md",
    spec: developerSpec,
    devDocPath: ".hoh/iterations/loop-02/development_document.md",
    developmentDocument,
    baseCandidateId: "loop-01-fixture",
    previousChangedPaths: ["game/main.txt"],
  });
  assert.match(developer.system, /large or unfamiliar files.*`grep` and `find`.*bounded partial reads/i);
  assert.match(developer.user, /PUBLIC_SPEC_SENTINEL/);
  assert.match(developer.user, /Canonical source: `\.hoh\/iterations\/loop-02\/development_document\.md`/);
  assert.match(developer.user, /\*\*MANDATORY\*\* `mandatory_from_planner`.*MANDATORY_PLANNER_SENTINEL.*Repair this before discretionary work/);
  assert.match(developer.user, /Paths changed in the previous loop/);
  assert.doesNotMatch(developer.user, /Canonical source: .*checks\.json/, "checks.json is not disclosed as a separate Developer context source");

  const tester = await renderTesterPrompts({
    loopIndex: 2,
    cwd: "/candidate",
    artifactDir: "game",
    spec: DEMO_SPEC,
    candidateId: "loop-02-fixture",
    baseCandidateId: "loop-01-fixture",
    candidateDiff,
    developmentDocument: "# Development Document\n\nTESTER_PLAN_SENTINEL",
    checksPath: "/workspace/.hoh/iterations/loop-02/checks.json",
    checks,
    claimCatalog: catalog,
    coverage,
  });
  assert.match(tester.user, /TESTER_PLAN_SENTINEL/);
  assert.match(tester.user, /Canonical source: `\/workspace\/\.hoh\/iterations\/loop-02\/checks\.json`/);
  assert.match(tester.user, /Actual base-vs-candidate diff/);
  assert.doesNotMatch(tester.user, /Developer's own summary/);
  assert.doesNotMatch(tester.user, /TESTER_LEDGER_SENTINEL/);
  assert.doesNotMatch(tester.user, /Issue ledger \(open and regressed issues\)/);
});

test("large role contexts retain canonical paths without leaking omitted bodies", async () => {
  const sentinel = "LARGE_ROLE_CONTEXT_SENTINEL";
  const largeBody = sentinel.repeat(500);
  const largeSpec = `# Large specification\n\n${largeBody}`;
  const catalog = makeClaimCatalog(largeSpec, [{ id: "large_claim", criterion: largeBody, requires: ["run"] }]);
  const coverage = emptyCoverage(catalog);
  const previous = evidence(largeBody);
  const planner = await renderPlannerPrompts({
    loopIndex: 2,
    cwd: "/workspace",
    artifactDir: ".",
    specPath: ".hoh/spec.md",
    spec: largeSpec,
    baseCandidateId: "loop-01-fixture",
    previousEvidence: previous,
    previousChecks: checks,
    ledger: emptyLedger(),
    claimCatalog: catalog,
    coverage,
  });
  assert.doesNotMatch(planner.user, new RegExp(sentinel));
  assert.match(planner.user, /`\.hoh\/spec\.md`/);
  assert.match(planner.user, /`\.hoh\/iterations\/loop-01\/evidence\.json`/);
  assert.match(planner.user, /`\.hoh\/claims\.json`/);
  assert.ok(Buffer.byteLength(planner.system, "utf8") + Buffer.byteLength(planner.user, "utf8") <= MAX_ROLE_PROMPT_BYTES);

  const largeDevelopmentDocument = `# Development Document\n\n${largeBody}`;
  const largeChangedPaths = Array.from({ length: 40 }, (_, index) =>
    `game/${"x".repeat(3_000)}-${index}${index === 39 ? sentinel : ""}`,
  );
  const developer = await renderDeveloperPrompts({
    loopIndex: 2,
    cwd: "/workspace",
    artifactDir: ".",
    specPath: ".hoh/spec.md",
    spec: largeSpec,
    devDocPath: ".hoh/iterations/loop-02/development_document.md",
    developmentDocument: largeDevelopmentDocument,
    baseCandidateId: "loop-01-fixture",
    previousChangedPaths: largeChangedPaths,
  });
  assert.doesNotMatch(developer.user, new RegExp(sentinel));
  assert.match(developer.user, /`\.hoh\/iterations\/loop-02\/development_document\.md`/);
  assert.match(developer.user, /`\.hoh\/iterations\/loop-01\/developer\.json`/);
  const optimizedDeveloperBytes = Buffer.byteLength(developer.system, "utf8") + Buffer.byteLength(developer.user, "utf8");
  assert.ok(optimizedDeveloperBytes <= MAX_ROLE_PROMPT_BYTES);
  const unboundedDeveloperBytes = Buffer.byteLength(
    [largeSpec, largeDevelopmentDocument, ...largeChangedPaths].join("\n"),
    "utf8",
  );
  const footprint = {
    before_bytes: unboundedDeveloperBytes,
    after_bytes: optimizedDeveloperBytes,
    before_estimated_tokens: Math.ceil(unboundedDeveloperBytes / 4),
    after_estimated_tokens: Math.ceil(optimizedDeveloperBytes / 4),
  };
  assert.ok(footprint.after_bytes < footprint.before_bytes / 4, JSON.stringify(footprint));
  assert.ok(footprint.after_estimated_tokens < footprint.before_estimated_tokens / 4, JSON.stringify(footprint));

  const largeChecks: CheckResult[] = [
    { name: "build", command: "npm run build", status: "fail", exit_code: 1, duration_ms: 25, stdout_tail: largeBody, stderr_tail: largeBody },
  ];
  const tester = await renderTesterPrompts({
    loopIndex: 2,
    cwd: "/candidate",
    artifactDir: ".",
    spec: largeSpec,
    candidateId: "loop-02-fixture",
    baseCandidateId: "loop-01-fixture",
    candidateDiff,
    developmentDocument: largeDevelopmentDocument,
    checksPath: "/workspace/.hoh/iterations/loop-02/checks.json",
    checks: largeChecks,
    claimCatalog: catalog,
    coverage,
  });
  assert.doesNotMatch(tester.user, new RegExp(sentinel));
  assert.match(tester.user, /`\/workspace\/\.hoh\/iterations\/loop-02\/checks\.json`/);
  assert.ok(Buffer.byteLength(tester.system, "utf8") + Buffer.byteLength(tester.user, "utf8") <= MAX_ROLE_PROMPT_BYTES);
});

test("final role prompt budget covers system and user UTF-8 bytes", () => {
  assert.doesNotThrow(() => assertRolePromptWithinLimit("planner", "system", "가".repeat(Math.floor((MAX_ROLE_PROMPT_BYTES - 6) / 3))));
  assert.throws(
    () => assertRolePromptWithinLimit("tester", "system", "가".repeat(Math.floor(MAX_ROLE_PROMPT_BYTES / 3) + 1)),
    /tester system\+user prompt is .* exceeding/,
  );
});
