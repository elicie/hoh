/**
 * Shared data model for the Harness-of-Harness (HoH) runtime.
 *
 * Notation follows the paper (arXiv 2609.01481):
 *   S    public specification (PRD)            -> `.hoh/spec.md`
 *   D_t  development document for loop t       -> `.hoh/iterations/loop-XX/development_document.md`
 *   A_t  artifact after loop t                 -> git commit + artifact tree hash (candidate id)
 *   E_t  evidence bundle produced by QA        -> `.hoh/iterations/loop-XX/evidence.json`
 */

export type Role = "planner" | "developer" | "tester";
export const ROLES: readonly Role[] = ["planner", "developer", "tester"];

// ---------------------------------------------------------------------------
// Evidence (E_t)
// ---------------------------------------------------------------------------

export const EXECUTION_EVIDENCE_TYPES = ["run", "test", "check", "screenshot", "replay", "runtime_trace", "log", "storage"] as const;
export const STATIC_EVIDENCE_TYPES = ["source", "config", "manifest"] as const;
export const EVIDENCE_TYPES = [...EXECUTION_EVIDENCE_TYPES, ...STATIC_EVIDENCE_TYPES] as const;

export type ExecutionEvidenceType = (typeof EXECUTION_EVIDENCE_TYPES)[number];
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export interface ExecutionRecord {
  /** Submitted types are constrained by ExecutionRecordSchema; unknown fallback values never qualify as execution evidence. */
  type: string;
  path?: string;
  /** Runtime-computed digest when path names a retained file in HOH_EVIDENCE_DIR. */
  sha256?: string;
  observation: string;
}

export type ClaimStatus = "verified" | "gap";
export type Severity = "minor" | "major" | "blocker";

export interface ClaimRecord {
  claim_id: string;
  claim: string;
  execution_records: ExecutionRecord[];
  status: ClaimStatus;
  severity?: Severity;
  player_impact?: string;
  recommended_update?: string;
}

export type QaStatus = "pass" | "partial" | "fail";

export interface PlannerHandoff {
  preservation_constraints: string[];
  update_targets: string[];
  validation_requirements: string[];
}

/** What the QA Tester submits through the `submit_evidence` tool. */
export interface EvidenceSubmission {
  qa_status: QaStatus;
  summary: string;
  verified_records: Omit<ClaimRecord, "status">[];
  gap_records: Omit<ClaimRecord, "status">[];
  planner_handoff: PlannerHandoff;
}

/** Normalized evidence bundle E_t written by the runtime. */
export interface EvidenceBundle {
  schema_version: 1;
  loop_index: number;
  candidate_id: string;
  /** Binds fixed-claim coverage to the catalog meaning used during this QA pass. */
  claim_catalog_sha256: string | null;
  qa_status: QaStatus;
  summary: string;
  verified_records: ClaimRecord[];
  gap_records: ClaimRecord[];
  planner_handoff: PlannerHandoff;
  checks: CheckResult[];
  candidate_source_sha256_before: string;
  candidate_source_sha256_after: string;
  /** true when the tester left the isolated candidate byte-identical */
  frozen: boolean;
  runtime_notes: string[];
  usage: RoleUsage;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Fixed PRD claims and cross-loop coverage
// ---------------------------------------------------------------------------

export interface ClaimDefinition {
  id: string;
  criterion: string;
  requires: ExecutionEvidenceType[];
  weight?: number;
}

export interface ClaimCatalog {
  schema_version: 1;
  spec_sha256: string;
  claims: ClaimDefinition[];
}

export type CoverageStatus = "verified" | "gap" | "untested";

export interface CoverageEntry {
  last_status: CoverageStatus;
  last_verified_loop: number | null;
  verified_count: number;
}

export interface CoverageState {
  schema_version: 1;
  claim_catalog_sha256: string;
  claims: Record<string, CoverageEntry>;
}

// ---------------------------------------------------------------------------
// Planning (D_t)
// ---------------------------------------------------------------------------

export interface Priority {
  name: string;
  action: string;
  observable_outcome: string;
}

/** What the Project Planner submits through `submit_development_document`. */
export interface PlannerOverlay {
  objective: string;
  priorities: Priority[];
  preservation_gate: string[];
  acceptance_gate: string[];
}

export interface PlannerRecord extends PlannerOverlay {
  schema_version: 1;
  loop_index: number;
  base_candidate_id: string | null;
  attempts: number;
  usage: RoleUsage;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Development (A_t)
// ---------------------------------------------------------------------------

export interface DeveloperRecord {
  schema_version: 1;
  loop_index: number;
  base_candidate_id: string | null;
  candidate_id: string;
  candidate_tree_sha: string;
  /** Exact pre-Developer Git endpoint; optional only for records from older runtimes. */
  base_commit_sha?: string;
  /** Exact frozen candidate Git endpoint; optional only for records from older runtimes. */
  candidate_commit_sha?: string;
  commit: string | null;
  changed_paths: string[];
  summary: string;
  violations: string[];
  usage: RoleUsage;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Deterministic checks (Runtime.check)
// ---------------------------------------------------------------------------

export interface CheckSpec {
  name: string;
  command: string;
  timeout_ms?: number;
  /** config-file friendly alternative to timeout_ms */
  timeout_min?: number;
}

export type CheckStatus = "pass" | "fail" | "timeout" | "error";

export interface CheckResult {
  name: string;
  command: string;
  status: CheckStatus;
  exit_code: number | null;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
  /** Paths are relative to the loop's evidence directory. */
  stdout_path?: string;
  stdout_sha256?: string;
  stderr_path?: string;
  stderr_sha256?: string;
}

// ---------------------------------------------------------------------------
// Issue ledger (cross-loop gap memory)
// ---------------------------------------------------------------------------

export type IssueStatus = "open" | "closed" | "regressed";

export interface Issue {
  id: string;
  claim: string;
  status: IssueStatus;
  severity?: Severity;
  first_seen_loop: number;
  last_seen_loop: number;
  closed_loop?: number;
  consecutive_gap_loops: number;
  reopen_count: number;
  player_impact?: string;
  recommended_update?: string;
  history: { loop: number; status: IssueStatus }[];
}

export interface Ledger {
  schema_version: 1;
  issues: Record<string, Issue>;
}

// ---------------------------------------------------------------------------
// Usage / run configuration
// ---------------------------------------------------------------------------

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface RoleUsage extends UsageTotals {
  turns: number;
  duration_ms: number;
  /** model actually used by the harness for this role, e.g. "anthropic/claude-opus-5:high" */
  model?: string;
}

export interface RoleContractReceipt {
  workspace: "active-read-only" | "active-writer" | "isolated-read-only";
  builtin_tools: string[];
  structured_tools: string[];
  system_prompt_sha256: string;
  user_prompt_sha256: string;
  output_contract_sha256: string;
}

/** Contract snapshot; paper runs enforce the run-start snapshot on resume. */
export interface ProtocolReceipt {
  schema_version: 1;
  origin: "run_start" | "legacy_reconstruction";
  mode: import("./runtime/config.js").ExecutionProtocol;
  legacy_default: boolean;
  initial_loops: number;
  runtime_version: string;
  harness: { name: string; version: string };
  models: Record<Role, string | null>;
  config_sha256: string;
  role_contracts: Record<Role, RoleContractReceipt>;
  protocol_sha256: string;
}

export interface RunConfig {
  schema_version: 1;
  run_id: string;
  /** relative to the workspace */
  spec_path: string;
  created_at: string;
  /** effective configuration for the most recent invocation (also stored in .hoh/config.json) */
  config: import("./runtime/config.js").HohConfig;
  config_source: string;
  /** Optional only while loading runs created before protocol receipts existed. */
  protocol_receipt?: ProtocolReceipt;
}
