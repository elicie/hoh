/**
 * Issue ledger: the cross-loop memory of gaps. Gap records open issues,
 * verified records close them, and a gap on a closed issue marks a regression.
 */
import type { CheckResult, ClaimRecord, Issue, Ledger, Severity } from "../types.js";

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2 };

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
  bundle: { loop_index: number; verified_records: ClaimRecord[]; gap_records: ClaimRecord[]; checks?: CheckResult[]; frozen?: boolean },
): LedgerDelta {
  // JSON round trips restore Object.prototype; claim IDs must remain data keys.
  ledger.issues = Object.assign(Object.create(null), ledger.issues);
  const loop = bundle.loop_index;
  const delta: LedgerDelta = { opened: [], reopened: [], closed: [], still_open: [] };
  const gaps = collapseRecords(bundle.gap_records, "gap");
  const gapIds = new Set(gaps.map((record) => record.claim_id));
  // One exact claim id is one observation per loop, and a gap always wins a
  // same-loop verified record for that identity.
  const verified = collapseRecords(bundle.verified_records, "verified").filter((record) => !gapIds.has(record.claim_id));

  // A completed loop without the same gap breaks its literal consecutive
  // streak. The issue remains open until positive verification closes it.
  for (const issue of Object.values(ledger.issues)) {
    if (issue.status !== "closed" && issue.last_seen_loop < loop && !gapIds.has(issue.id)) issue.consecutive_gap_loops = 0;
  }

  for (const gap of gaps) {
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
    if (existing.status === "closed") {
      existing.last_seen_loop = loop;
      existing.status = "regressed";
      existing.reopen_count += 1;
      existing.consecutive_gap_loops = 1;
      delete existing.closed_loop;
      existing.history.push({ loop, status: "regressed" });
      delta.reopened.push(gap.claim_id);
    } else if (existing.last_seen_loop === loop) {
      // A retry or duplicate application of the same loop must not create a
      // second observation, streak increment, or history entry.
      continue;
    } else {
      existing.consecutive_gap_loops = existing.last_seen_loop === loop - 1 ? existing.consecutive_gap_loops + 1 : 1;
      existing.last_seen_loop = loop;
      delta.still_open.push(gap.claim_id);
    }
  }

  const resolvedIds = new Set(verified.map((record) => record.claim_id));
  // Unbound checks may resolve their own runtime failure, but must never
  // manufacture a verified product claim or turn a failing QA into PASS.
  if (bundle.frozen && !gaps.some((gap) => gap.claim_id.startsWith("runtime.") && gap.severity === "blocker")) {
    for (const check of bundle.checks ?? []) {
      const id = `check.${check.name}`;
      if (gapIds.has(id) || check.status !== "pass" || check.exit_code !== 0 || check.execution?.exit_code !== 0) continue;
      if (ledger.issues[id]?.claim !== `Deterministic check "${check.name}" passes (${check.command}).`) continue;
      const intact = ["stdout", "stderr"].every((stream) => {
        const file = stream === "stdout" ? check.stdout_path : check.stderr_path;
        const sha = stream === "stdout" ? check.stdout_sha256 : check.stderr_sha256;
        return file && sha && check.execution!.files.some((captured) => captured.path === file && captured.sha256 === sha);
      });
      if (intact) resolvedIds.add(id);
    }
  }
  for (const id of resolvedIds) {
    const existing = ledger.issues[id];
    if (!existing || existing.status === "closed") continue;
    existing.status = "closed";
    existing.closed_loop = loop;
    existing.consecutive_gap_loops = 0;
    existing.history.push({ loop, status: "closed" });
    delta.closed.push(id);
  }

  return delta;
}

function collapseRecords(records: ClaimRecord[], status: ClaimRecord["status"]): ClaimRecord[] {
  const collapsed = new Map<string, ClaimRecord>();
  for (const record of records) {
    const claimId = record.claim_id.trim();
    if (!claimId) continue;
    const next: ClaimRecord = { ...record, claim_id: claimId, status };
    const current = collapsed.get(claimId);
    if (!current) {
      collapsed.set(claimId, next);
      continue;
    }
    collapsed.set(claimId, {
      ...current,
      claim: next.claim || current.claim,
      execution_records: [...current.execution_records, ...next.execution_records],
      severity: strongerSeverity(current.severity, next.severity),
      player_impact: next.player_impact ?? current.player_impact,
      recommended_update: next.recommended_update ?? current.recommended_update,
    });
  }
  return [...collapsed.values()];
}

function strongerSeverity(a: Severity | undefined, b: Severity | undefined): Severity | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
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

export function openIssues(ledger: Ledger): Issue[] {
  return Object.values(ledger.issues)
    .filter((i) => i.status !== "closed")
    .sort((a, b) => {
      const sa = SEVERITY_RANK[a.severity ?? "minor"];
      const sb = SEVERITY_RANK[b.severity ?? "minor"];
      if (sa !== sb) return sa - sb;
      if (a.consecutive_gap_loops !== b.consecutive_gap_loops) return b.consecutive_gap_loops - a.consecutive_gap_loops;
      return compareIds(a.id, b.id);
    });
}

/** Issues that the next Planner and Developer must handle before discretionary work. */
export function escalatedIssues(ledger: Ledger): Issue[] {
  return openIssues(ledger).filter((issue) => issue.severity === "blocker" || issue.consecutive_gap_loops >= 2);
}

export function renderEscalatedIssues(ledger: Ledger, opts: { headingLevel?: 2 | 3 } = {}): string {
  const issues = escalatedIssues(ledger);
  const heading = "#".repeat(opts.headingLevel ?? 3);
  const lines = [`${heading} Mandatory next-loop issues`, ""];
  if (issues.length === 0) return [...lines, "_None._"].join("\n");
  lines.push("Address these unresolved issues before discretionary work:", "");
  for (const issue of issues) {
    const reasons = [issue.severity === "blocker" ? "blocker" : "", issue.consecutive_gap_loops >= 2 ? `${issue.consecutive_gap_loops} consecutive gaps` : ""]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `- **MANDATORY** \`${issue.id}\` [${reasons}]: ${cell(issue.claim)}${issue.recommended_update ? ` → ${cell(issue.recommended_update)}` : ""}`,
    );
  }
  return lines.join("\n");
}

export function renderLedger(ledger: Ledger, opts: { openOnly?: boolean } = {}): string {
  if (opts.openOnly) {
    const mandatory = escalatedIssues(ledger);
    const mandatoryIds = new Set(mandatory.map((issue) => issue.id));
    const other = openIssues(ledger).filter((issue) => !mandatoryIds.has(issue.id));
    return [
      renderEscalatedIssues(ledger),
      "",
      "### Other open issues",
      "",
      other.length ? renderIssueTable(other) : "_None._",
    ].join("\n");
  }
  const issues = Object.values(ledger.issues).sort((a, b) => compareIds(a.id, b.id));
  if (issues.length === 0) return "_The ledger is empty._";
  return renderIssueTable(issues);
}

function renderIssueTable(issues: Issue[]): string {
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

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
