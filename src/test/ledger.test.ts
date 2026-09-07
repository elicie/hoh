import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvidence, emptyLedger, escalatedIssues, ledgerSummary, openIssues, renderLedger } from "../runtime/ledger.js";
import { renderDevelopmentDocument } from "../runtime/prompts.js";
import type { ClaimRecord } from "../types.js";

const gap = (id: string, severity: ClaimRecord["severity"] = "major", claim = `${id.trim()} works`): ClaimRecord => ({
  claim_id: id,
  claim,
  execution_records: [],
  status: "gap",
  severity,
});
const ok = (id: string): ClaimRecord => ({ claim_id: id, claim: `${id} works`, execution_records: [], status: "verified" });

test("ledger: open -> closed -> regressed transitions", () => {
  const ledger = emptyLedger();

  let d = applyEvidence(ledger, { loop_index: 1, verified_records: [], gap_records: [gap("a"), gap("b", "minor")] });
  assert.deepEqual(d.opened, ["a", "b"]);
  assert.equal(ledger.issues.a.status, "open");
  assert.equal(ledger.issues.a.consecutive_gap_loops, 1);

  d = applyEvidence(ledger, { loop_index: 2, verified_records: [ok("a")], gap_records: [gap("b", "minor")] });
  assert.deepEqual(d.closed, ["a"]);
  assert.deepEqual(d.still_open, ["b"]);
  assert.equal(ledger.issues.a.status, "closed");
  assert.equal(ledger.issues.a.closed_loop, 2);
  assert.equal(ledger.issues.b.consecutive_gap_loops, 2);

  d = applyEvidence(ledger, { loop_index: 3, verified_records: [ok("b")], gap_records: [gap("a", "blocker")] });
  assert.deepEqual(d.reopened, ["a"]);
  assert.equal(ledger.issues.a.status, "regressed");
  assert.equal(ledger.issues.a.reopen_count, 1);
  assert.equal(ledger.issues.a.severity, "blocker");
  assert.equal(ledger.issues.b.status, "closed");

  assert.deepEqual(ledgerSummary(ledger), { open: 0, regressed: 1, closed: 1, all: 2 });
  assert.deepEqual(
    openIssues(ledger).map((i) => i.id),
    ["a"],
  );
  assert.deepEqual(
    ledger.issues.a.history.map((h) => h.status),
    ["open", "closed", "regressed"],
  );

  const replay = applyEvidence(ledger, { loop_index: 3, verified_records: [ok("b")], gap_records: [gap("a", "blocker")] });
  assert.deepEqual(replay, { opened: [], reopened: [], closed: [], still_open: [] });
  assert.equal(ledger.issues.a.reopen_count, 1);
  assert.deepEqual(
    ledger.issues.a.history.map((h) => h.status),
    ["open", "closed", "regressed"],
  );
});

test("ledger: verified claims that were never gaps are not issues", () => {
  const ledger = emptyLedger();
  applyEvidence(ledger, { loop_index: 1, verified_records: [ok("x")], gap_records: [] });
  assert.deepEqual(ledgerSummary(ledger), { open: 0, regressed: 0, closed: 0, all: 0 });
});

test("ledger: exact trimmed ids collapse once per loop, strongest gap wins, and gap beats verified", () => {
  const ledger = emptyLedger();
  const delta = applyEvidence(ledger, {
    loop_index: 1,
    verified_records: [ok("feature")],
    gap_records: [
      gap(" feature ", "minor", "Original wording"),
      gap("feature", "blocker", "Updated wording"),
      gap("Feature", "minor", "Updated wording"),
      gap("other_feature", "minor", "Updated wording"),
    ],
  });

  assert.deepEqual(delta.opened, ["feature", "Feature", "other_feature"]);
  assert.deepEqual(Object.keys(ledger.issues), ["feature", "Feature", "other_feature"]);
  assert.equal(ledger.issues.feature.status, "open", "a same-loop gap must beat verified");
  assert.equal(ledger.issues.feature.severity, "blocker");
  assert.equal(ledger.issues.feature.consecutive_gap_loops, 1, "duplicates are one loop observation");
  assert.equal(ledger.issues.feature.claim, "Updated wording");
  assert.equal(ledger.issues.Feature.claim, ledger.issues.other_feature.claim, "equal claim text does not merge different ids");

  applyEvidence(ledger, { loop_index: 2, verified_records: [], gap_records: [gap("feature", "minor", "Changed behavior wording")] });
  assert.equal(ledger.issues.feature.claim, "Changed behavior wording", "claim text may change without changing identity");
  assert.equal(ledger.issues.feature.consecutive_gap_loops, 2);
});

test("ledger: streaks require adjacent loops and same-loop replay is idempotent", () => {
  const consecutive = emptyLedger();
  applyEvidence(consecutive, { loop_index: 1, verified_records: [], gap_records: [gap("repeat")] });
  const replay = applyEvidence(consecutive, { loop_index: 1, verified_records: [], gap_records: [gap(" repeat ")] });
  assert.deepEqual(replay, { opened: [], reopened: [], closed: [], still_open: [] });
  assert.equal(consecutive.issues.repeat.consecutive_gap_loops, 1);
  assert.deepEqual(consecutive.issues.repeat.history, [{ loop: 1, status: "open" }]);

  applyEvidence(consecutive, { loop_index: 2, verified_records: [], gap_records: [gap("repeat")] });
  assert.equal(consecutive.issues.repeat.consecutive_gap_loops, 2);
  applyEvidence(consecutive, { loop_index: 2, verified_records: [], gap_records: [gap("repeat")] });
  assert.equal(consecutive.issues.repeat.consecutive_gap_loops, 2, "replaying the second observation must not reach three");

  const skipped = emptyLedger();
  applyEvidence(skipped, { loop_index: 1, verified_records: [], gap_records: [gap("repeat")] });
  applyEvidence(skipped, { loop_index: 2, verified_records: [], gap_records: [] });
  assert.equal(skipped.issues.repeat.consecutive_gap_loops, 0, "an omitted completed loop resets the streak immediately");
  assert.deepEqual(escalatedIssues(skipped), []);
  applyEvidence(skipped, { loop_index: 3, verified_records: [], gap_records: [gap("repeat")] });
  assert.equal(skipped.issues.repeat.consecutive_gap_loops, 1, "an unobserved intervening loop breaks the streak");
});

test("ledger: blockers and two-loop gaps are mandatory with stable ordering", () => {
  const ledger = emptyLedger();
  applyEvidence(ledger, {
    loop_index: 1,
    verified_records: [],
    gap_records: [gap("z_blocker", "blocker"), gap("a_blocker", "blocker"), gap("repeat", "major"), gap("ordinary", "major")],
  });
  assert.deepEqual(
    escalatedIssues(ledger).map((issue) => issue.id),
    ["a_blocker", "z_blocker"],
    "a blocker is mandatory after its first observation",
  );

  applyEvidence(ledger, { loop_index: 2, verified_records: [], gap_records: [gap("repeat", "major")] });
  assert.deepEqual(
    escalatedIssues(ledger).map((issue) => issue.id),
    ["a_blocker", "z_blocker", "repeat"],
    "a repeated non-blocker is mandatory after two adjacent loops",
  );
  assert.deepEqual(
    openIssues(ledger).map((issue) => issue.id),
    ["a_blocker", "z_blocker", "repeat", "ordinary"],
  );

  const rendered = renderLedger(ledger, { openOnly: true });
  assert.ok(rendered.indexOf("### Mandatory next-loop issues") < rendered.indexOf("### Other open issues"));
  assert.match(rendered, /MANDATORY.*`a_blocker` \[blocker\]/);
  assert.match(rendered, /MANDATORY.*`repeat` \[2 consecutive gaps\]/);
  assert.match(rendered, /Other open issues[\s\S]*`ordinary`/);
  assert.doesNotMatch(rendered.slice(rendered.indexOf("### Other open issues")), /`a_blocker`|`z_blocker`|`repeat`/);

  const developmentDocument = renderDevelopmentDocument({
    loopIndex: 3,
    baseCandidateId: "loop-02-candidate",
    overlay: {
      objective: "Repair the escalated failures",
      priorities: [{ name: "Repair", action: "Fix mandatory issues", observable_outcome: "The affected behaviors pass" }],
      preservation_gate: [],
      acceptance_gate: ["Mandatory issues are exercised"],
    },
    previousEvidence: null,
    ledger,
    previousChecks: null,
  });
  assert.ok(
    developmentDocument.indexOf("## Mandatory next-loop issues") < developmentDocument.indexOf("## Priority Order"),
    "the Developer sees runtime escalations before discretionary Planner priorities",
  );
  assert.match(developmentDocument, /MANDATORY.*`a_blocker`/);
});


test("ledger: prototype property IDs survive persistence and all issue transitions", () => {
  const ids = ["constructor", "__proto__", "toString", "hasOwnProperty"];
  const constructorBefore = Object.getOwnPropertyDescriptors(Object);
  const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
  let ledger = emptyLedger();
  assert.deepEqual(applyEvidence(ledger, { loop_index: 1, verified_records: ids.map(ok), gap_records: [] }).closed, []);
  assert.equal(Object.keys(ledger.issues).length, 0);
  assert.deepEqual(applyEvidence(ledger, { loop_index: 2, verified_records: [], gap_records: ids.map((id) => gap(id)) }).opened, ids);
  ledger = JSON.parse(JSON.stringify(ledger));
  assert.deepEqual(applyEvidence(ledger, { loop_index: 3, verified_records: ids.map(ok), gap_records: [] }).closed, ids);
  ledger = JSON.parse(JSON.stringify(ledger));
  assert.deepEqual(applyEvidence(ledger, { loop_index: 4, verified_records: [], gap_records: ids.map((id) => gap(id)) }).reopened, ids);
  assert.equal(Object.keys(ledger.issues).length, ids.length);
  for (const id of ids) assert.deepEqual(ledger.issues[id].history.map((entry) => entry.status), ["open", "closed", "regressed"]);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object), constructorBefore);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
});
