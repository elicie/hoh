import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvidence, emptyLedger, ledgerSummary, openIssues } from "../runtime/ledger.js";
import type { ClaimRecord } from "../types.js";

const gap = (id: string, severity: ClaimRecord["severity"] = "major"): ClaimRecord => ({
  claim_id: id,
  claim: `${id} works`,
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
});

test("ledger: verified claims that were never gaps are not issues", () => {
  const ledger = emptyLedger();
  applyEvidence(ledger, { loop_index: 1, verified_records: [ok("x")], gap_records: [] });
  assert.deepEqual(ledgerSummary(ledger), { open: 0, regressed: 0, closed: 0, all: 0 });
});
