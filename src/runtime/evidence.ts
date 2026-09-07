/** Evidence normalization; file and execution provenance are enforced by bindEvidenceFiles. */
import type { CheckResult, ClaimCatalog, ClaimRecord, EvidenceBundle, EvidenceSubmission, QaStatus, RoleUsage } from "../types.js";
import { EXECUTION_EVIDENCE_TYPES } from "../types.js";
import { claimCatalogSha256 } from "./coverage.js";

interface NormalizeInput {
  submission: EvidenceSubmission | null;
  loopIndex: number;
  candidateId: string;
  checks: CheckResult[];
  before: string;
  after: string;
  finalText: string;
  usage: RoleUsage;
  attempts: number;
  /** paths in the main workspace touched during QA (reverted by the runtime) */
  workspaceViolations?: string[];
  claimCatalog?: ClaimCatalog;
  /** Recorded candidate tree before checks; any post-check mismatch invalidates QA. */
  expectedCandidateSha?: string;
}

export function normalizeEvidence(input: NormalizeInput): EvidenceBundle {
  const executionEvidenceTypes = new Set<string>(EXECUTION_EVIDENCE_TYPES);
  const fixedClaims = new Map(input.claimCatalog?.claims.map((claim) => [claim.id, claim]) ?? []);
  const notes: string[] = [];
  const frozen = input.before === input.after;
  let sub = input.submission;
  if (!sub || typeof sub !== "object") {
    notes.push(`tester returned no structured evidence after ${input.attempts} attempt(s); recorded as a gap`);
    sub = {
      qa_status: "fail",
      summary: "QA Tester did not deliver structured evidence.",
      verified_records: [],
      gap_records: [
        {
          claim_id: "tester.no_structured_output",
          claim: "The QA Tester must deliver structured evidence matching the required schema.",
          execution_records: [{ type: "log", path: "tester.final_text", observation: (input.finalText || "(no output)").slice(0, 2000) }],
          severity: "major",
          recommended_update: "Re-run QA; make behaviors easier to observe so the tester can cite records.",
        },
      ],
      planner_handoff: { preservation_constraints: [], update_targets: ["Obtain structured QA evidence for the candidate"], validation_requirements: [] },
    };
  }

  const toRecords = (list: unknown, status: ClaimRecord["status"]): ClaimRecord[] =>
    (Array.isArray(list) ? list : [])
      .filter((r) => r && typeof r === "object" && typeof (r as any).claim_id === "string")
      .map((r: any) => ({
        claim_id: String(r.claim_id).trim(),
        claim: String(r.claim ?? "").trim(),
        execution_records: (Array.isArray(r.execution_records) ? r.execution_records : []).map((x: any) => ({
          type: String(x?.type ?? "other"),
          path: x?.path ? String(x.path) : undefined,
          observation: String(x?.observation ?? ""),
        })),
        status,
        severity: r.severity,
        player_impact: r.player_impact,
        recommended_update: r.recommended_update,
      }));

  const gaps = toRecords(sub.gap_records, "gap");
  const gapIds = new Set(gaps.map((g) => g.claim_id));
  // A claim cannot be both verified and a gap: the gap wins.
  const verifiedCandidates = toRecords(sub.verified_records, "verified").filter((v) => {
    if (gapIds.has(v.claim_id)) {
      notes.push(`claim ${v.claim_id} was listed as both verified and gap; kept as gap`);
      return false;
    }
    return true;
  });
  const verified: ClaimRecord[] = [];
  for (const record of verifiedCandidates) {
    const observedTypes = new Set(record.execution_records.map((e) => e.type));
    if (!record.execution_records.some((e) => executionEvidenceTypes.has(e.type))) {
      gaps.push({ ...record, status: "gap", severity: "minor" });
      gapIds.add(record.claim_id);
      notes.push(`claim ${record.claim_id}: source-only evidence downgraded to gap`);
      continue;
    }
    const missing = (fixedClaims.get(record.claim_id)?.requires ?? []).filter((type) => !observedTypes.has(type));
    if (missing.length) {
      gaps.push({ ...record, status: "gap", severity: "minor" });
      gapIds.add(record.claim_id);
      notes.push(`claim ${record.claim_id}: missing required evidence types: ${missing.join(", ")}`);
      continue;
    }
    verified.push(record);
  }

  for (const c of input.checks) {
    if (c.status === "pass") continue;
    const boundIds = Object.keys(c.claims ?? {});
    for (const id of boundIds.length ? boundIds : [`check.${c.name}`]) {
      const outputPath = c.stderr_tail ? c.stderr_path : c.stdout_path;
      const outputSha256 = c.stderr_tail ? c.stderr_sha256 : c.stdout_sha256;
      const executionRecord = {
        type: "check",
        path: outputPath ?? c.name,
        ...(outputSha256 ? { sha256: outputSha256 } : {}),
        observation: `${c.status}, exit ${c.exit_code ?? "-"}: ${(c.stderr_tail || c.stdout_tail).trim().slice(-500)}`,
      };
      const recommendedUpdate = `Make "${c.command}" succeed on the artifact.`;
      const existingGap = gaps.find((gap) => gap.claim_id === id);
      if (existingGap) {
        existingGap.claim = c.claims?.[id]?.trim() ?? `Deterministic check "${c.name}" passes (${c.command}).`;
        if (!existingGap.execution_records.some((record) => record.type === "check" && record.path === executionRecord.path)) {
          existingGap.execution_records.push(executionRecord);
        }
        existingGap.severity = "blocker";
        existingGap.recommended_update = recommendedUpdate;
        notes.push(`claim ${id}: deterministic check failure enforced as blocker`);
      } else {
        gaps.push({
          claim_id: id,
          claim: c.claims?.[id]?.trim() ?? `Deterministic check "${c.name}" passes (${c.command}).`,
          execution_records: [executionRecord],
          status: "gap",
          severity: "blocker",
          recommended_update: recommendedUpdate,
        });
        gapIds.add(id);
      }
    }
  }
  if (!frozen) {
    notes.push(`candidate mutated during QA (tree ${input.before.slice(0, 12)} → ${input.after.slice(0, 12)}); observations are not bound to the candidate`);
    gaps.push({
      claim_id: "runtime.candidate_mutated",
      claim: "The QA Tester leaves the frozen candidate unmodified.",
      execution_records: [{ type: "runtime_trace", observation: `artifact tree changed during QA: ${input.before} → ${input.after}` }],
      status: "gap",
      severity: "blocker",
      recommended_update: "QA must only build, run, and inspect; it must not edit files.",
    });
  }

  if (input.expectedCandidateSha && input.before !== input.expectedCandidateSha) {
    notes.push(
      `candidate mutated during deterministic checks (tree ${input.expectedCandidateSha.slice(0, 12)} → ${input.before.slice(0, 12)})`,
    );
    gaps.push({
      claim_id: "runtime.candidate_mutated_by_checks",
      claim: "Deterministic checks leave the frozen candidate source tree unchanged.",
      execution_records: [
        {
          type: "runtime_trace",
          observation: `artifact tree changed during checks: ${input.expectedCandidateSha} → ${input.before}`,
        },
      ],
      status: "gap",
      severity: "blocker",
      recommended_update: "Checks and worktree_setup must not modify tracked candidate source files.",
    });
  }

  if (input.workspaceViolations?.length) {
    notes.push(`tester modified the main workspace (${input.workspaceViolations.slice(0, 10).join(", ")}); changes were reverted`);
    gaps.push({
      claim_id: "runtime.workspace_mutated_by_tester",
      claim: "The QA Tester does not modify the development workspace.",
      execution_records: [{ type: "runtime_trace", observation: `reverted: ${input.workspaceViolations.slice(0, 20).join(", ")}` }],
      status: "gap",
      severity: "blocker",
      recommended_update: "QA must only build, run, and inspect the isolated candidate copy.",
    });
  }

  const finalGapIds = new Set(gaps.map((gap) => gap.claim_id));
  const resolvedVerified = verified.filter((record) => {
    if (!finalGapIds.has(record.claim_id)) return true;
    notes.push(`claim ${record.claim_id} conflicted with a runtime gap; kept as gap`);
    return false;
  });

  let qa_status: QaStatus;
  if (sub.qa_status === "fail" || !frozen || gaps.some((g) => g.severity === "blocker") || resolvedVerified.length === 0) qa_status = "fail";
  else if (sub.qa_status === "partial" || gaps.length > 0) qa_status = "partial";
  else qa_status = "pass";

  const handoff = sub.planner_handoff && typeof sub.planner_handoff === "object" ? sub.planner_handoff : ({} as any);
  return {
    schema_version: 1,
    loop_index: input.loopIndex,
    candidate_id: input.candidateId,
    claim_catalog_sha256: input.claimCatalog?.claims.length ? claimCatalogSha256(input.claimCatalog) : null,
    qa_status,
    summary: String(sub.summary ?? "").trim(),
    verified_records: resolvedVerified,
    gap_records: gaps,
    planner_handoff: {
      preservation_constraints: strList(handoff.preservation_constraints),
      update_targets: strList(handoff.update_targets),
      validation_requirements: strList(handoff.validation_requirements),
    },
    checks: input.checks,
    candidate_source_sha256_before: input.before,
    candidate_source_sha256_after: input.after,
    frozen,
    runtime_notes: notes,
    usage: input.usage,
    created_at: new Date().toISOString(),
  };
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}
