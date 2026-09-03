/**
 * Role prompt construction (paper appendix A.2): fixed Markdown modules in
 * `prompts/` plus runtime slots rendered here. The development document D_t
 * is a deterministic scaffold with the planner's overlay inserted.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES, type CheckResult, type ClaimCatalog, type CoverageState, type EvidenceBundle, type Ledger, type PlannerOverlay, type Role } from "../types.js";
import { renderChecks } from "./checks.js";
import { renderCoverageTable } from "./coverage.js";
import { openIssues, renderLedger } from "./ledger.js";

const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

const cache = new Map<string, string>();
async function template(name: string): Promise<string> {
  let t = cache.get(name);
  if (t === undefined) {
    t = await readFile(path.join(PROMPTS_DIR, `${name}.md`), "utf8");
    cache.set(name, t);
  }
  return t;
}

export async function rolePromptTemplateHashes(): Promise<Record<Role, { system: string; user: string }>> {
  const entries = await Promise.all(
    ROLES.map(async (role) => {
      const [system, user] = await Promise.all([template(`${role}.system`), template(`${role}.user`)]);
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      return [role, { system: digest(system), user: digest(user) }] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<Role, { system: string; user: string }>;
}

export function render(tpl: string, slots: Record<string, string | number | null | undefined>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const v = slots[key];
    return v === null || v === undefined ? "" : String(v);
  });
}

export interface RolePrompts {
  system: string;
  user: string;
}

async function rolePrompts(role: Role, slots: Record<string, string | number | null | undefined>): Promise<RolePrompts> {
  return {
    system: render(await template(`${role}.system`), slots),
    user: render(await template(`${role}.user`), slots),
  };
}

// ---------------------------------------------------------------------------
// Shared sections
// ---------------------------------------------------------------------------

export function renderEvidence(e: EvidenceBundle | null): string {
  if (!e) return "_None: this is the first iteration._";
  const lines: string[] = [];
  lines.push(`- Candidate assessed: \`${e.candidate_id}\` (loop ${e.loop_index})`);
  lines.push(`- QA status: **${e.qa_status.toUpperCase()}**${e.frozen ? "" : " (candidate was mutated during QA; assessment invalid)"}`);
  lines.push(`- Summary: ${e.summary}`);
  lines.push("", "### Verified behaviors (preserve)");
  if (e.verified_records.length === 0) lines.push("_None verified._");
  for (const r of e.verified_records) {
    lines.push(`- \`${r.claim_id}\`: ${r.claim}`);
    for (const x of r.execution_records) {
      lines.push(`  - ${x.type}${x.path ? ` \`${x.path}\`` : ""}${x.sha256 ? ` (sha256 ${x.sha256.slice(0, 12)})` : ""}: ${x.observation}`);
    }
  }
  lines.push("", "### Gaps (repair or gather evidence)");
  if (e.gap_records.length === 0) lines.push("_No gaps recorded._");
  for (const r of e.gap_records) {
    lines.push(`- \`${r.claim_id}\` [${r.severity ?? "unrated"}]: ${r.claim}`);
    for (const x of r.execution_records) {
      lines.push(`  - ${x.type}${x.path ? ` \`${x.path}\`` : ""}${x.sha256 ? ` (sha256 ${x.sha256.slice(0, 12)})` : ""}: ${x.observation}`);
    }
    if (r.player_impact) lines.push(`  - impact: ${r.player_impact}`);
    if (r.recommended_update) lines.push(`  - recommended: ${r.recommended_update}`);
  }
  const h = e.planner_handoff;
  lines.push("", "### Tester handoff");
  lines.push(`- Preserve: ${h.preservation_constraints.length ? h.preservation_constraints.join("; ") : "-"}`);
  lines.push(`- Update targets: ${h.update_targets.length ? h.update_targets.join("; ") : "-"}`);
  lines.push(`- Validation: ${h.validation_requirements.length ? h.validation_requirements.join("; ") : "-"}`);
  if (e.runtime_notes.length) {
    lines.push("", "### Runtime notes");
    for (const n of e.runtime_notes) lines.push(`- ${n}`);
  }
  return lines.join("\n");
}

function checksSection(checks: CheckResult[] | null): string {
  if (checks === null) return "_Not yet executed (first iteration or no candidate)._";
  return renderChecks(checks);
}

// ---------------------------------------------------------------------------
// Development document D_t
// ---------------------------------------------------------------------------

export interface DevelopmentDocumentInput {
  loopIndex: number;
  baseCandidateId: string | null;
  overlay: PlannerOverlay;
  previousEvidence: EvidenceBundle | null;
  ledger: Ledger;
  previousChecks: CheckResult[] | null;
}

export function renderDevelopmentDocument(input: DevelopmentDocumentInput): string {
  const { overlay, loopIndex } = input;
  const lines: string[] = [];
  lines.push(`# Development Document — Iteration ${loopIndex}`, "");
  lines.push(`- Base candidate: \`${input.baseCandidateId ?? "none (empty workspace)"}\``);
  lines.push(`- Previous QA status: ${input.previousEvidence ? input.previousEvidence.qa_status.toUpperCase() : "n/a"}`);
  lines.push("", "## Objective", "", overlay.objective, "");
  lines.push("## Priority Order", "");
  overlay.priorities.forEach((p, i) => {
    lines.push(`${i + 1}. **${p.name}** — ${p.action}`);
    lines.push(`   - Observable outcome: ${p.observable_outcome}`);
  });
  lines.push("", "## Preservation Gate", "");
  if (overlay.preservation_gate.length === 0) lines.push("- (nothing verified yet)");
  for (const g of overlay.preservation_gate) lines.push(`- ${g}`);
  lines.push("", "## Acceptance Gate", "");
  for (const g of overlay.acceptance_gate) lines.push(`- ${g}`);
  lines.push("", "## Context carried from previous evidence", "");
  const e = input.previousEvidence;
  if (!e) {
    lines.push("_First iteration: no prior evidence._");
  } else {
    lines.push(`- Verified behaviors: ${e.verified_records.map((r) => `\`${r.claim_id}\``).join(", ") || "none"}`);
    lines.push(`- Gaps recorded: ${e.gap_records.map((r) => `\`${r.claim_id}\``).join(", ") || "none"}`);
    lines.push(`- Tester summary: ${e.summary}`);
  }
  const open = openIssues(input.ledger);
  lines.push("", "## Open issues (ledger)", "");
  if (open.length === 0) lines.push("_None._");
  for (const i of open) {
    lines.push(
      `- \`${i.id}\` [${i.severity ?? "unrated"}, ${i.status}, ${i.consecutive_gap_loops} loop(s)]: ${i.claim}${i.recommended_update ? ` → ${i.recommended_update}` : ""}`,
    );
  }
  lines.push("", "## Deterministic checks on the base candidate", "", checksSection(input.previousChecks));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Role prompts
// ---------------------------------------------------------------------------

export interface PlannerPromptInput {
  loopIndex: number;
  cwd: string;
  artifactDir: string;
  specPath: string;
  spec: string;
  baseCandidateId: string | null;
  previousEvidence: EvidenceBundle | null;
  previousChecks: CheckResult[] | null;
  ledger: Ledger;
  claimCatalog: ClaimCatalog;
  coverage: CoverageState;
}

export async function renderPlannerPrompts(input: PlannerPromptInput): Promise<RolePrompts> {
  const first = input.loopIndex === 1 || !input.previousEvidence;
  return rolePrompts("planner", {
    loop_index: input.loopIndex,
    cwd: input.cwd,
    artifact_dir: input.artifactDir,
    spec_path: input.specPath,
    spec: input.spec,
    base_candidate: input.baseCandidateId ? `${input.baseCandidateId}${input.baseCandidateId.startsWith("loop-00-") ? " (provided initial artifact, not yet assessed)" : ""}` : "none (empty workspace)",
    evidence_section: renderEvidence(input.previousEvidence),
    coverage_section: renderCoverageTable(input.claimCatalog, input.coverage),
    ledger_section: renderLedger(input.ledger, { openOnly: true }),
    checks_section: checksSection(input.previousChecks),
    evidence_instruction: first
      ? "There is no previous-iteration evidence. Plan the first bounded increment that makes the project launchable and observable, so that QA has something concrete to verify."
      : "Identify verified functionality to preserve, visible bugs and unmet requirements to repair, and evidence that remains insufficient. Blockers and regressions come before product extensions. Do not reconstruct the previous development document.",
  });
}

export interface DeveloperPromptInput {
  loopIndex: number;
  cwd: string;
  artifactDir: string;
  specPath: string;
  spec: string;
  devDocPath: string;
  developmentDocument: string;
  baseCandidateId: string | null;
  previousChangedPaths: string[];
  previousChecks: CheckResult[] | null;
}

export async function renderDeveloperPrompts(input: DeveloperPromptInput): Promise<RolePrompts> {
  const provided = input.baseCandidateId?.startsWith("loop-00-");
  const warm = input.baseCandidateId
    ? [
        provided
          ? `The artifact directory already contains a provided initial artifact (candidate \`${input.baseCandidateId}\`). Inspect it first and build on it.`
          : `Continue from candidate \`${input.baseCandidateId}\` already present in the artifact directory.`,
        input.previousChangedPaths.length
          ? `Paths changed in the previous loop: ${input.previousChangedPaths
              .slice(0, 40)
              .map((p) => `\`${p}\``)
              .join(", ")}${input.previousChangedPaths.length > 40 ? ", …" : ""}`
          : "",
        "Preserve verified functionality and repair the next observable gap rather than replacing a working project with a smaller reset.",
      ]
        .filter(Boolean)
        .join("\n")
    : "The artifact directory is empty (or contains only the specification). Create the initial project structure so that the artifact is launchable and its behavior is observable.";
  return rolePrompts("developer", {
    loop_index: input.loopIndex,
    cwd: input.cwd,
    artifact_dir: input.artifactDir,
    spec_path: input.specPath,
    spec: input.spec,
    dev_doc_path: input.devDocPath,
    development_document: input.developmentDocument,
    warm_start_section: warm,
    checks_section: checksSection(input.previousChecks),
  });
}

export interface TesterPromptInput {
  loopIndex: number;
  cwd: string;
  artifactDir: string;
  spec: string;
  candidateId: string;
  baseCandidateId: string | null;
  developerSummary: string;
  developmentDocument: string;
  checks: CheckResult[];
  ledger: Ledger;
  claimCatalog: ClaimCatalog;
  coverage: CoverageState;
}

export async function renderTesterPrompts(input: TesterPromptInput): Promise<RolePrompts> {
  return rolePrompts("tester", {
    loop_index: input.loopIndex,
    cwd: input.cwd,
    artifact_dir: input.artifactDir,
    spec: input.spec,
    candidate_id: input.candidateId,
    base_candidate: input.baseCandidateId ?? "none",
    developer_summary: input.developerSummary.trim() ? indent(input.developerSummary.trim()) : "_(no summary)_",
    development_document: input.developmentDocument,
    checks_section: renderChecks(input.checks),
    ledger_section: renderLedger(input.ledger, { openOnly: true }),
    coverage_section: renderCoverageTable(input.claimCatalog, input.coverage),
  });
}

export async function renderClaimDraftPrompts(input: { cwd: string; specPath: string; spec: string }): Promise<RolePrompts> {
  return {
    system: render(await template("claims.system"), {}),
    user: render(await template("claims.user"), {
      cwd: input.cwd,
      spec_path: input.specPath,
      spec: input.spec,
    }),
  };
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}
