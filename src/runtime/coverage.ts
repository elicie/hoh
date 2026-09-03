/** Fixed PRD claim catalog and cross-loop coverage state. */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import type {
  ClaimCatalog,
  ClaimDefinition,
  CoverageEntry,
  CoverageState,
  CoverageStatus,
  EvidenceBundle,
  ExecutionEvidenceType,
} from "../types.js";
import { EXECUTION_EVIDENCE_TYPES } from "../types.js";
import { parseLoopDirName, readJson, type RunPaths } from "./state.js";

const CLAIM_ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const EXECUTION_TYPES = new Set<string>(EXECUTION_EVIDENCE_TYPES);

export function specSha256(spec: string): string {
  return createHash("sha256").update(spec).digest("hex");
}

/** Stable identity for the normalized catalog whose claim meanings evidence covers. */
export function claimCatalogSha256(catalog: ClaimCatalog): string {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

export function normalizeClaimDefinitions(value: unknown): ClaimDefinition[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("claim catalog must contain at least one claim");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`claims[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const criterion = typeof item.criterion === "string" ? item.criterion.trim() : "";
    if (!CLAIM_ID.test(id)) throw new Error(`claims[${index}].id must be stable snake_case`);
    if (seen.has(id)) throw new Error(`duplicate claim id "${id}"`);
    if (!criterion) throw new Error(`claims[${index}].criterion must not be empty`);
    if (!Array.isArray(item.requires)) throw new Error(`claims[${index}].requires must be an array`);
    const requires: ExecutionEvidenceType[] = [];
    for (const type of item.requires) {
      if (typeof type !== "string" || !EXECUTION_TYPES.has(type)) {
        throw new Error(`claims[${index}].requires contains unsupported evidence type "${String(type)}"`);
      }
      if (!requires.includes(type as ExecutionEvidenceType)) requires.push(type as ExecutionEvidenceType);
    }
    const weight = item.weight;
    if (weight !== undefined && (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0)) {
      throw new Error(`claims[${index}].weight must be a positive number`);
    }
    seen.add(id);
    return { id, criterion, requires, ...(weight === undefined ? {} : { weight }) };
  });
}

export function makeClaimCatalog(spec: string, claims: unknown): ClaimCatalog {
  return { schema_version: 1, spec_sha256: specSha256(spec), claims: normalizeClaimDefinitions(claims) };
}

export function parseClaimCatalog(value: unknown, spec: string): ClaimCatalog {
  if (!value || typeof value !== "object") throw new Error("claims.json must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== 1) throw new Error("claims.json schema_version must be 1");
  const expected = specSha256(spec);
  if (raw.spec_sha256 !== expected) {
    throw new Error(`claims.json spec_sha256 does not match .hoh/spec.md (expected ${expected})`);
  }
  return { schema_version: 1, spec_sha256: expected, claims: normalizeClaimDefinitions(raw.claims) };
}

export async function loadClaimCatalog(paths: RunPaths, spec: string): Promise<ClaimCatalog | null> {
  const raw = await readJson<unknown>(paths.claims);
  return raw === null ? null : parseClaimCatalog(raw, spec);
}

export function emptyCoverage(catalog: ClaimCatalog): CoverageState {
  return {
    schema_version: 1,
    claim_catalog_sha256: claimCatalogSha256(catalog),
    claims: Object.fromEntries(catalog.claims.map((claim) => [claim.id, { last_status: "untested", last_verified_loop: null, verified_count: 0 }])),
  };
}

function coverageEntry(value: unknown): CoverageEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!(raw.last_status === "verified" || raw.last_status === "gap" || raw.last_status === "untested")) return null;
  if (!(raw.last_verified_loop === null || (Number.isInteger(raw.last_verified_loop) && Number(raw.last_verified_loop) > 0))) return null;
  if (!Number.isInteger(raw.verified_count) || Number(raw.verified_count) < 0) return null;
  return {
    last_status: raw.last_status as CoverageStatus,
    last_verified_loop: raw.last_verified_loop as number | null,
    verified_count: Number(raw.verified_count),
  };
}

export function reconcileCoverage(catalog: ClaimCatalog, value: unknown): CoverageState {
  const catalogHash = claimCatalogSha256(catalog);
  const rawClaims =
    value &&
    typeof value === "object" &&
    (value as any).schema_version === 1 &&
    (value as any).claim_catalog_sha256 === catalogHash &&
    (value as any).claims &&
    typeof (value as any).claims === "object"
      ? (value as any).claims
      : {};
  const claims: Record<string, CoverageEntry> = {};
  for (const claim of catalog.claims) {
    claims[claim.id] = coverageEntry(rawClaims[claim.id]) ?? { last_status: "untested", last_verified_loop: null, verified_count: 0 };
  }
  return { schema_version: 1, claim_catalog_sha256: catalogHash, claims };
}

export async function loadCoverage(paths: RunPaths, catalog: ClaimCatalog): Promise<CoverageState> {
  return reconcileCoverage(catalog, await readJson<unknown>(paths.coverage));
}

export async function rebuildCoverage(paths: RunPaths, catalog: ClaimCatalog): Promise<CoverageState> {
  let names: string[] = [];
  try {
    names = await readdir(paths.iterations);
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyCoverage(catalog);
    throw error;
  }
  const loops = names
    .map(parseLoopDirName)
    .filter((loop): loop is number => loop !== null)
    .sort((a, b) => a - b);
  let coverage = emptyCoverage(catalog);
  const catalogHash = claimCatalogSha256(catalog);
  for (const loop of loops) {
    const evidence = await readJson<EvidenceBundle>(paths.evidenceJson(loop));
    if (!evidence) continue;
    if (evidence.loop_index !== loop) {
      throw new Error(`${paths.evidenceJson(loop)} records loop ${evidence.loop_index}, expected ${loop}`);
    }
    // Legacy evidence and evidence for an edited catalog cannot prove the current claim meanings.
    if (evidence.claim_catalog_sha256 !== catalogHash) continue;
    coverage = applyCoverage(catalog, coverage, evidence);
  }
  return coverage;
}

export function applyCoverage(catalog: ClaimCatalog, coverage: CoverageState, evidence: EvidenceBundle): CoverageState {
  if (!Number.isSafeInteger(evidence.loop_index) || evidence.loop_index < 1) {
    throw new Error(`coverage evidence loop_index must be a positive integer, got ${evidence.loop_index}`);
  }
  if (evidence.claim_catalog_sha256 !== claimCatalogSha256(catalog)) {
    throw new Error("coverage evidence does not match the current fixed claim catalog");
  }
  const verified = new Set(evidence.verified_records.map((record) => record.claim_id));
  const gaps = new Set(evidence.gap_records.map((record) => record.claim_id));
  const next = reconcileCoverage(catalog, coverage);
  for (const claim of catalog.claims) {
    const entry = next.claims[claim.id];
    if (gaps.has(claim.id)) {
      entry.last_status = "gap";
    } else if (verified.has(claim.id)) {
      entry.last_status = "verified";
      if (entry.last_verified_loop !== evidence.loop_index) entry.verified_count += 1;
      entry.last_verified_loop = evidence.loop_index;
    } else {
      entry.last_status = "untested";
    }
  }
  return next;
}

export interface CoverageSummary {
  verified: number;
  gap: number;
  untested: number;
  all: number;
}

export function coverageSummary(catalog: ClaimCatalog, coverage: CoverageState): CoverageSummary {
  const summary: CoverageSummary = { verified: 0, gap: 0, untested: 0, all: catalog.claims.length };
  for (const claim of catalog.claims) summary[coverage.claims[claim.id]?.last_status ?? "untested"] += 1;
  return summary;
}

export function renderCoverageTable(catalog: ClaimCatalog, coverage: CoverageState): string {
  const lines = [
    "| Claim | Status | Requires | Last verified | Count | Weight | Criterion |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const claim of catalog.claims) {
    const entry = coverage.claims[claim.id] ?? { last_status: "untested", last_verified_loop: null, verified_count: 0 };
    lines.push(
      `| \`${claim.id}\` | ${entry.last_status} | ${claim.requires.join(", ") || "any execution"} | ${entry.last_verified_loop ?? "-"} | ${entry.verified_count} | ${claim.weight ?? "-"} | ${cell(claim.criterion)} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Role-facing coverage index. Gaps come first, then claims never verified,
 * followed by previously verified claims from stalest to most recent.
 * Criteria stay in the canonical claim catalog and are only inlined by the
 * disclosure layer when that complete view is small.
 */
export function renderCoveragePriorityIndex(catalog: ClaimCatalog, coverage: CoverageState): string {
  const claims = [...catalog.claims].sort((a, b) => {
    const aEntry = coverage.claims[a.id] ?? { last_status: "untested", last_verified_loop: null, verified_count: 0 };
    const bEntry = coverage.claims[b.id] ?? { last_status: "untested", last_verified_loop: null, verified_count: 0 };
    const aRank = coveragePriorityRank(aEntry);
    const bRank = coveragePriorityRank(bEntry);
    if (aRank !== bRank) return aRank - bRank;
    if (aRank >= 2 && aEntry.last_verified_loop !== bEntry.last_verified_loop) {
      return (aEntry.last_verified_loop ?? 0) - (bEntry.last_verified_loop ?? 0);
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const lines = [
    "| Claim | Status | Requires | Last verified | Count | Weight | Priority |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const claim of claims) {
    const entry = coverage.claims[claim.id] ?? { last_status: "untested", last_verified_loop: null, verified_count: 0 };
    const priority = entry.last_status === "gap" ? "gap" : entry.last_verified_loop === null ? "never-tested" : entry.last_status === "untested" ? "stale" : "recent";
    lines.push(
      `| \`${claim.id}\` | ${entry.last_status} | ${claim.requires.join(", ") || "any execution"} | ${entry.last_verified_loop ?? "-"} | ${entry.verified_count} | ${claim.weight ?? "-"} | ${priority} |`,
    );
  }
  return lines.join("\n");
}

function coveragePriorityRank(entry: CoverageEntry): number {
  if (entry.last_status === "gap") return 0;
  if (entry.last_verified_loop === null) return 1;
  return entry.last_status === "untested" ? 2 : 3;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
