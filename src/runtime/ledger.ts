/**
 * Issue ledger: the cross-loop memory of gaps. Gap records open issues,
 * verified records close them, and a gap on a closed issue marks a regression.
 */
import type { ClaimRecord, Issue, Ledger, Severity } from "../types.js";

export function emptyLedger(): Ledger {
  return { schema_version: 1, issues: {} };
}

export interface LedgerDelta {
  opened: string[];
  reopened: string[];
  closed: string[];
  still_open: string[];
}

export function applyEvidence(
  ledger: Ledger,
  bundle: { loop_index: number; verified_records: ClaimRecord[]; gap_records: ClaimRecord[] },
): LedgerDelta {
  const loop = bundle.loop_index;
  const delta: LedgerDelta = { opened: [], reopened: [], closed: [], still_open: [] };

  for (const gap of bundle.gap_records) {
    const existing = ledger.issues[gap.claim_id];
    if (!existing) {
      ledger.issues[gap.claim_id] = {
        id: gap.claim_id,
        claim: gap.claim,
        status: "open",
        severity: gap.severity,
        first_seen_loop: loop,
        last_seen_loop: loop,
        consecutive_gap_loops: 1,
        reopen_count: 0,
        player_impact: gap.player_impact,
        recommended_update: gap.recommended_update,
        history: [{ loop, status: "open" }],
      };
      delta.opened.push(gap.claim_id);
      continue;
    }
    existing.claim = gap.claim || existing.claim;
    existing.severity = gap.severity ?? existing.severity;
    existing.player_impact = gap.player_impact ?? existing.player_impact;
    existing.recommended_update = gap.recommended_update ?? existing.recommended_update;
    existing.last_seen_loop = loop;
    if (existing.status === "closed") {
      existing.status = "regressed";
      existing.reopen_count += 1;
      existing.consecutive_gap_loops = 1;
      delete existing.closed_loop;
      existing.history.push({ loop, status: "regressed" });
      delta.reopened.push(gap.claim_id);
    } else {
      existing.consecutive_gap_loops += 1;
      delta.still_open.push(gap.claim_id);
    }
  }

  for (const ok of bundle.verified_records) {
    const existing = ledger.issues[ok.claim_id];
    if (!existing || existing.status === "closed") continue;
    existing.status = "closed";
    existing.closed_loop = loop;
    existing.consecutive_gap_loops = 0;
    existing.history.push({ loop, status: "closed" });
    delta.closed.push(ok.claim_id);
  }

  return delta;
}

export interface LedgerSummary {
  open: number;
  regressed: number;
  closed: number;
  all: number;
}

export function ledgerSummary(ledger: Ledger): LedgerSummary {
  const s: LedgerSummary = { open: 0, regressed: 0, closed: 0, all: 0 };
  for (const issue of Object.values(ledger.issues)) {
    s.all += 1;
    s[issue.status] += 1;
  }
  return s;
}

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2 };

export function openIssues(ledger: Ledger): Issue[] {
  return Object.values(ledger.issues)
    .filter((i) => i.status !== "closed")
    .sort((a, b) => {
      const sa = SEVERITY_RANK[a.severity ?? "minor"];
      const sb = SEVERITY_RANK[b.severity ?? "minor"];
      if (sa !== sb) return sa - sb;
      return b.consecutive_gap_loops - a.consecutive_gap_loops;
    });
}

export function renderLedger(ledger: Ledger, opts: { openOnly?: boolean } = {}): string {
  const issues = opts.openOnly ? openIssues(ledger) : Object.values(ledger.issues);
  if (issues.length === 0) return opts.openOnly ? "_No open issues._" : "_The ledger is empty._";
  const lines = [
    "| ID | Status | Severity | Loops open | First seen | Claim | Recommended update |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const i of issues) {
    lines.push(
      `| \`${i.id}\` | ${i.status}${i.reopen_count ? ` (reopened ×${i.reopen_count})` : ""} | ${i.severity ?? "-"} | ${i.consecutive_gap_loops} | ${i.first_seen_loop} | ${cell(i.claim)} | ${cell(i.recommended_update ?? "")} |`,
    );
  }
  return lines.join("\n");
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
