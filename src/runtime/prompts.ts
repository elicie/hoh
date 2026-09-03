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
import type { CandidateDiffBundle } from "./candidate-diff.js";
import { renderCoveragePriorityIndex, renderCoverageTable } from "./coverage.js";
import { escalatedIssues, openIssues, renderEscalatedIssues, renderLedger } from "./ledger.js";

const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

export const MAX_ROLE_PROMPT_BYTES = 96 * 1024;
export const MAX_INLINE_CONTEXT_BYTES = 8 * 1024;
export const MAX_CONTEXT_INDEX_BYTES = 4 * 1024;

export function assertRolePromptWithinLimit(role: Role, systemPrompt: string, userPrompt: string): void {
  const bytes = Buffer.byteLength(systemPrompt, "utf8") + Buffer.byteLength(userPrompt, "utf8");
  if (bytes > MAX_ROLE_PROMPT_BYTES) {
    throw new Error(`${role} system+user prompt is ${bytes} bytes, exceeding the ${MAX_ROLE_PROMPT_BYTES}-byte limit`);
  }
}

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
  const prompts = {
    system: render(await template(`${role}.system`), slots),
    user: render(await template(`${role}.user`), slots),
  };
  assertRolePromptWithinLimit(role, prompts.system, prompts.user);
  return prompts;
}

// ---------------------------------------------------------------------------
// Shared sections
// ---------------------------------------------------------------------------

export interface ContextDisclosureInput {
  sourcePath: string | readonly string[] | null;
  content: string;
  index: string;
}

/** Render a path-first, bounded view of a canonical runtime context source. */
export function renderContextDisclosure(input: ContextDisclosureInput): string {
  const sourcePaths = input.sourcePath === null ? [] : Array.isArray(input.sourcePath) ? input.sourcePath : [input.sourcePath];
  const contentBytes = Buffer.byteLength(input.content, "utf8");
  const inline = contentBytes <= MAX_INLINE_CONTEXT_BYTES;
  const lines = [
    `- Canonical source: ${sourcePaths.length ? sourcePaths.map((source) => `\`${normalizePromptPath(source)}\``).join(", ") : "_(not created yet)_"}`,
    `- Disclosed-view SHA-256: \`${createHash("sha256").update(input.content).digest("hex")}\``,
    `- Disclosed-view size: ${contentBytes} UTF-8 bytes`,
    `- Disclosure: ${inline ? "exact view inline" : `index only (exact view exceeds ${MAX_INLINE_CONTEXT_BYTES} bytes)`}`,
    "",
    "### Bounded index",
    "",
    boundUtf8(input.index.trim() || "_No index entries._", MAX_CONTEXT_INDEX_BYTES, "\n… [index truncated; read the canonical source]"),
  ];
  if (inline) {
    lines.push("", "### Exact disclosed view (inline)", "", "--- BEGIN EXACT VIEW ---", input.content, "--- END EXACT VIEW ---");
  } else {
    lines.push("", `_Exact view omitted. Read ${sourcePaths.length ? sourcePaths.map((source) => `\`${normalizePromptPath(source)}\``).join(" and ") : "the canonical runtime record"} when the index is insufficient._`);
  }
  return lines.join("\n");
}

function normalizePromptPath(value: string): string {
  return value.replaceAll(path.sep, "/");
}

function loopRecordPath(loopIndex: number, fileName: string): string {
  return `.hoh/iterations/loop-${String(loopIndex).padStart(2, "0")}/${fileName}`;
}

function boundUtf8(value: string, maxBytes: number, marker: string): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const bodyLimit = Math.max(0, maxBytes - markerBytes);
  let body = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > bodyLimit) break;
    body += character;
    bytes += size;
  }
  return `${body}${marker}`;
}

function documentIndex(content: string): string {
  const lines = content.split(/\r?\n/);
  const headings = lines
    .map((line, index) => ({ line: index + 1, heading: /^(#{1,6})\s+(.+?)\s*$/.exec(line) }))
    .filter((entry): entry is { line: number; heading: RegExpExecArray } => entry.heading !== null)
    .map((entry) => `- line ${entry.line}: ${entry.heading[1]} ${entry.heading[2]}`);
  return [`- ${lines.length} lines`, ...(headings.length ? headings : ["- No Markdown headings; read the canonical source."])].join("\n");
}

function evidenceIndex(evidence: EvidenceBundle | null): string {
  if (!evidence) return "- First iteration: no previous evidence record.";
  return [
    `- Loop ${evidence.loop_index}; candidate \`${evidence.candidate_id}\`; QA ${evidence.qa_status.toUpperCase()}; frozen: ${evidence.frozen ? "yes" : "no"}`,
    `- Verified ids (${evidence.verified_records.length}): ${evidence.verified_records.map((record) => `\`${record.claim_id}\``).join(", ") || "none"}`,
    `- Gap ids (${evidence.gap_records.length}): ${evidence.gap_records.map((record) => `\`${record.claim_id}\``).join(", ") || "none"}`,
    `- Handoff: ${evidence.planner_handoff.preservation_constraints.length} preserve, ${evidence.planner_handoff.update_targets.length} update, ${evidence.planner_handoff.validation_requirements.length} validation item(s)`,
  ].join("\n");
}

function ledgerIndex(ledger: Ledger): string {
  const issues = openIssues(ledger);
  if (issues.length === 0) return "- No open or regressed issues.";
  const mandatoryIds = new Set(escalatedIssues(ledger).map((issue) => issue.id));
  const ordered = [...issues.filter((issue) => mandatoryIds.has(issue.id)), ...issues.filter((issue) => !mandatoryIds.has(issue.id))];
  return ordered
    .map((issue) => {
      const claim = issue.claim.replace(/\s+/g, " ").trim();
      const update = issue.recommended_update?.replace(/\s+/g, " ").trim();
      return `- ${mandatoryIds.has(issue.id) ? "**MANDATORY** " : ""}\`${issue.id}\`: ${issue.status}; ${issue.severity ?? "unrated"}; ${issue.consecutive_gap_loops} consecutive gap loop(s); ${claim}${update ? ` → ${update}` : ""}`;
    })
    .join("\n");
}

function checksIndex(checks: CheckResult[] | null): string {
  if (checks === null) return "- No prior candidate checks are available.";
  if (checks.length === 0) return "- No deterministic checks are configured.";
  return checks.map((check) => `- \`${check.name}\`: ${check.status.toUpperCase()}; exit ${check.exit_code ?? "-"}`).join("\n");
}

function specDisclosure(specPath: string, spec: string): string {
  return renderContextDisclosure({ sourcePath: specPath, content: spec, index: documentIndex(spec) });
}

function evidenceDisclosure(loopIndex: number, evidence: EvidenceBundle | null): string {
  const content = renderEvidence(evidence);
  return renderContextDisclosure({
    sourcePath: evidence ? loopRecordPath(loopIndex - 1, "evidence.json") : null,
    content,
    index: evidenceIndex(evidence),
  });
}

function ledgerDisclosure(ledger: Ledger): string {
  return renderContextDisclosure({ sourcePath: ".hoh/ledger.json", content: renderLedger(ledger, { openOnly: true }), index: ledgerIndex(ledger) });
}

function checksDisclosure(sourcePath: string | null, checks: CheckResult[] | null): string {
  return renderContextDisclosure({
    sourcePath: checks === null ? null : sourcePath,
    content: checksSection(checks),
    index: checksIndex(checks),
  });
}

function coverageDisclosure(claimCatalog: ClaimCatalog, coverage: CoverageState): string {
  return renderContextDisclosure({
    sourcePath: [".hoh/claims.json", ".hoh/coverage.json"],
    content: renderCoverageTable(claimCatalog, coverage),
    index: renderCoveragePriorityIndex(claimCatalog, coverage),
  });
}

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
  lines.push("", renderEscalatedIssues(input.ledger, { headingLevel: 2 }), "");
  lines.push("## Objective", "", overlay.objective, "");
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
    spec_section: specDisclosure(input.specPath, input.spec),
    base_candidate: input.baseCandidateId ? `${input.baseCandidateId}${input.baseCandidateId.startsWith("loop-00-") ? " (provided initial artifact, not yet assessed)" : ""}` : "none (empty workspace)",
    evidence_section: evidenceDisclosure(input.loopIndex, input.previousEvidence),
    coverage_section: coverageDisclosure(input.claimCatalog, input.coverage),
    ledger_section: ledgerDisclosure(input.ledger),
    checks_section: checksDisclosure(input.previousChecks === null ? null : loopRecordPath(input.loopIndex - 1, "checks.json"), input.previousChecks),
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
  const warmIndex = [
    `- Base candidate: \`${input.baseCandidateId ?? "none"}\`${provided ? " (provided initial artifact)" : ""}`,
    `- Previous changed paths: ${input.previousChangedPaths.length}`,
    ...input.previousChangedPaths.map((changedPath) => `  - \`${changedPath}\``),
  ].join("\n");
  return rolePrompts("developer", {
    loop_index: input.loopIndex,
    cwd: input.cwd,
    artifact_dir: input.artifactDir,
    spec_path: input.specPath,
    spec_section: specDisclosure(input.specPath, input.spec),
    dev_doc_path: input.devDocPath,
    development_document_section: renderContextDisclosure({
      sourcePath: input.devDocPath,
      content: input.developmentDocument,
      index: documentIndex(input.developmentDocument),
    }),
    warm_start_section: renderContextDisclosure({
      sourcePath: input.baseCandidateId && !provided && input.loopIndex > 1 ? loopRecordPath(input.loopIndex - 1, "developer.json") : null,
      content: warm,
      index: warmIndex,
    }),
  });
}

export interface TesterPromptInput {
  loopIndex: number;
  cwd: string;
  artifactDir: string;
  spec: string;
  candidateId: string;
  baseCandidateId: string | null;
  candidateDiff: CandidateDiffBundle;
  developmentDocument: string;
  /** Absolute main-workspace path: current checks are committed after the frozen worktree is created. */
  checksPath: string;
  checks: CheckResult[];
  claimCatalog: ClaimCatalog;
  coverage: CoverageState;
}

export async function renderTesterPrompts(input: TesterPromptInput): Promise<RolePrompts> {
  const specPath = ".hoh/spec.md";
  const developmentDocumentPath = loopRecordPath(input.loopIndex, "development_document.md");
  return rolePrompts("tester", {
    loop_index: input.loopIndex,
    cwd: input.cwd,
    artifact_dir: input.artifactDir,
    spec: input.spec,
    candidate_id: input.candidateId,
    base_candidate: input.baseCandidateId ?? "none",
    base_commit_sha: input.candidateDiff.baseCommit,
    candidate_commit_sha: input.candidateDiff.candidateCommit,
    candidate_diff_mode: input.candidateDiff.mode,
    candidate_diff_file_count: input.candidateDiff.changedFileCount,
    candidate_diff_inline: input.candidateDiff.inline,
    candidate_diff_inspect_command: input.candidateDiff.inspectCommand,
    development_document_section: renderContextDisclosure({
      sourcePath: developmentDocumentPath,
      content: input.developmentDocument,
      index: documentIndex(input.developmentDocument),
    }),
    checks_section: checksDisclosure(input.checksPath, input.checks),
    coverage_section: coverageDisclosure(input.claimCatalog, input.coverage),
    spec_section: specDisclosure(specPath, input.spec),
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
