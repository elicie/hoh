/** Durable, bounded files collected by deterministic checks and the QA Tester. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { CheckResult, ClaimCatalog, ClaimRecord, EvidenceBundle, EvidenceExecution, ExecutionRecord } from "../types.js";
import { EXECUTION_EVIDENCE_TYPES } from "../types.js";

export const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_EVIDENCE_LOOP_BYTES = 30 * 1024 * 1024;

const FILE_BACKED_TYPES = new Set(["screenshot", "replay", "log", "storage"]);

interface StoredFile {
  absolute: string;
  relative: string;
  bytes: number;
  sha256: string;
}

interface EvidenceInventory {
  directory: string;
  files: Map<string, StoredFile>;
  rejected: Map<string, string>;
  notes: string[];
}

export async function prepareEvidenceDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

/**
 * Enforce storage limits, reject links/special files, and bind cited files to
 * their runtime-computed digest. Paths stored in evidence.json are relative to
 * the loop's evidence directory and therefore portable with the run record.
 */
export async function bindEvidenceFiles(bundle: EvidenceBundle, directory: string, catalog?: ClaimCatalog, qaExecutions: EvidenceExecution[] = []): Promise<EvidenceBundle> {
  const inventory = await inventoryEvidence(directory);
  const runtimeNotes = [...bundle.runtime_notes, ...inventory.notes];
  const unusableRecords = new WeakSet<ExecutionRecord>();
  const executions = [...bundle.checks.flatMap((check) => check.execution ? [check.execution] : []), ...qaExecutions];
  const provenance = new Map<string, EvidenceExecution>();
  for (const execution of executions) {
    if (execution.exit_code !== 0) continue;
    for (const file of execution.files) provenance.set(`${file.path}\0${file.sha256}`, execution);
  }

  const bindRecord = (claimId: string, record: ExecutionRecord): ExecutionRecord => {
    const { sha256: _submittedHash, execution_id: _submittedExecution, ...withoutHash } = record;
    if (!record.path) {
      unusableRecords.add(withoutHash);
      return withoutHash;
    }
    const reference = resolveReference(record.path, directory, inventory.files);
    if (reference.kind === "file") {
      const execution = provenance.get(`${reference.file.relative}\0${reference.file.sha256}`);
      const bound = { ...withoutHash, path: reference.file.relative, sha256: reference.file.sha256,
        ...(execution ? { execution_id: execution.id } : {}) };
      if (!execution) unusableRecords.add(bound);
      return bound;
    }
    if (reference.kind === "unsafe") {
      runtimeNotes.push(`claim ${claimId}: evidence path is outside HOH_EVIDENCE_DIR: ${record.path}`);
    } else if (reference.kind === "missing" || (reference.kind === "ordinary" && FILE_BACKED_TYPES.has(record.type))) {
      const relative = reference.kind === "missing" ? reference.relative : portable(record.path);
      const reason = inventory.rejected.get(relative);
      runtimeNotes.push(
        reason
          ? `claim ${claimId}: evidence file unavailable (${reason}): ${relative}`
          : `claim ${claimId}: evidence file not found: ${relative}`,
      );
    }
    unusableRecords.add(withoutHash);
    return withoutHash;
  };

  const bindClaims = (records: EvidenceBundle["verified_records"]): EvidenceBundle["verified_records"] =>
    records.map((record) => ({
      ...record,
      execution_records: record.execution_records.map((execution) => bindRecord(record.claim_id, execution)),
    }));

  const fixedClaims = new Map(catalog?.claims.map((claim) => [claim.id, claim]) ?? []);
  // The check configuration fixes the meaning of a claim independently of QA.
  // A successful QA shell is provenance, never authority to invent a verified criterion.
  const authorities = new Map<string, { criterion: string; checks: CheckResult[] }>();
  for (const check of bundle.checks) {
    for (const [id, criterion] of Object.entries(check.claims ?? {})) {
      const previous = authorities.get(id);
      if (previous) previous.checks.push(check);
      else authorities.set(id, { criterion: criterion.trim(), checks: [check] });
    }
  }
  const checkAnchor = (check: CheckResult): ExecutionRecord | undefined => {
    if (check.status !== "pass" || check.exit_code !== 0 || check.execution?.exit_code !== 0) return;
    let anchor: ExecutionRecord | undefined;
    for (const value of [check.stdout_path, check.stderr_path]) {
      if (!value) continue;
      const reference = resolveReference(value, directory, inventory.files);
      if (reference.kind !== "file") return;
      const file = reference.file;
      if (!check.execution.files.some((captured) => captured.path === file.relative && captured.sha256 === file.sha256)) return;
      anchor ??= { type: "check", path: file.relative, sha256: file.sha256, execution_id: check.execution.id,
        observation: `Predeclared check ${JSON.stringify(check.name)} passed (exit 0).` };
    }
    return anchor;
  };
  const boundVerified = bindClaims(bundle.verified_records);
  const downgraded: ClaimRecord[] = [];
  const verified = boundVerified.filter((record) => {
    const authority = authorities.get(record.claim_id);
    const reasons: string[] = [];
    if (!authority) reasons.push("no predeclared check binding");
    else {
      // Preserve the predeclared meaning even if QA reuses its ID with inflated prose.
      record.claim = authority.criterion;
      const catalogCriterion = fixedClaims.get(record.claim_id)?.criterion.trim();
      if (catalogCriterion && catalogCriterion !== authority.criterion) reasons.push("check criterion conflicts with the fixed catalog");
      for (const check of authority.checks) {
        if (check.claims![record.claim_id].trim() !== authority.criterion) reasons.push("conflicting check criteria");
        const anchor = checkAnchor(check);
        if (!anchor) reasons.push(`bound check ${JSON.stringify(check.name)} failed or lacks intact execution evidence`);
        else record.execution_records.push(anchor);
      }
    }
    if (!bundle.frozen || bundle.gap_records.some((gap) => gap.claim_id.startsWith("runtime.") && gap.severity === "blocker")) {
      reasons.push("candidate or runtime integrity was violated");
    }
    const usableTypes = new Set(
      record.execution_records
        .filter((execution) => !unusableRecords.has(execution) && (!FILE_BACKED_TYPES.has(execution.type) || Boolean(execution.sha256)))
        .map((execution) => execution.type),
    );
    const hasExecution = EXECUTION_EVIDENCE_TYPES.some((type) => usableTypes.has(type));
    const missingRequired = (fixedClaims.get(record.claim_id)?.requires ?? []).filter((type) => !usableTypes.has(type));
    if (missingRequired.length) reasons.push(`missing required types ${missingRequired.join(", ")}`);
    if (hasExecution && missingRequired.length === 0 && reasons.length === 0) return true;
    downgraded.push({ ...record, status: "gap", severity: record.severity ?? "minor" });
    runtimeNotes.push(
      `claim ${record.claim_id}: ${reasons.length ? reasons.join("; ") : `retained evidence files lack matching successful runtime execution provenance or ${missingRequired.length ? `required types ${missingRequired.join(", ")}` : "execution evidence"}`}; downgraded to gap`,
    );
    return false;
  });

  const gapRecords = [...bindClaims(bundle.gap_records), ...downgraded];
  const gapIds = new Set(gapRecords.map((record) => record.claim_id));
  const resolvedVerified = verified.filter((record) => {
    if (!gapIds.has(record.claim_id)) return true;
    runtimeNotes.push(`claim ${record.claim_id}: file binding produced a gap for the same ID; kept as gap`);
    return false;
  });
  const checks = bundle.checks.map((check) => bindCheckFiles(check, inventory, runtimeNotes));
  const checksFailed = checks.some((check) => check.status !== "pass");
  const qaStatus =
    bundle.qa_status === "fail" || !bundle.frozen || checksFailed || gapRecords.some((record) => record.severity === "blocker") || resolvedVerified.length === 0
      ? "fail"
      : bundle.qa_status === "partial" || gapRecords.length
        ? "partial"
        : "pass";
  return {
    ...bundle,
    qa_status: qaStatus,
    verified_records: resolvedVerified,
    gap_records: gapRecords,
    checks,
    executions,
    runtime_notes: unique(runtimeNotes),
  };
}

/** Apply the same bounds when a Tester attempt aborts before an evidence bundle exists. */
export async function sanitizeEvidenceDirectory(directory: string): Promise<string[]> {
  return (await inventoryEvidence(directory)).notes;
}

async function inventoryEvidence(directory: string): Promise<EvidenceInventory> {
  const candidates: Array<Omit<StoredFile, "sha256">> = [];
  const rejected = new Map<string, string>();
  const notes: string[] = [];
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    await rm(directory, { force: true });
    await mkdir(directory, { recursive: true });
    notes.push("evidence root replaced (only a real directory is allowed)");
    return { directory, files: new Map(), rejected, notes };
  }

  const walk = async (relativeDirectory: string): Promise<void> => {
    const absoluteDirectory = path.join(directory, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => comparePortable(a.name, b.name))) {
      const relative = portable(path.join(relativeDirectory, entry.name));
      const absolute = path.join(directory, ...relative.split("/"));
      if (entry.isDirectory()) {
        await walk(relative);
        continue;
      }
      if (!entry.isFile()) {
        const kind = entry.isSymbolicLink() ? "symbolic link" : "special file";
        await rm(absolute, { recursive: true, force: true });
        rejected.set(relative, kind);
        notes.push(`evidence entry removed (${kind} is not allowed): ${relative}`);
        continue;
      }
      const info = await lstat(absolute);
      if (info.size > MAX_EVIDENCE_FILE_BYTES) {
        await rm(absolute, { force: true });
        rejected.set(relative, `${info.size} bytes exceeds the ${MAX_EVIDENCE_FILE_BYTES}-byte file limit`);
        notes.push(`evidence file removed (file limit): ${relative} (${info.size} bytes)`);
        continue;
      }
      candidates.push({ absolute, relative, bytes: info.size });
    }
  };

  await walk("");
  candidates.sort((a, b) => evidencePriority(a.relative) - evidencePriority(b.relative) || comparePortable(a.relative, b.relative));
  const files = new Map<string, StoredFile>();
  let retainedBytes = 0;
  for (const candidate of candidates) {
    if (retainedBytes + candidate.bytes > MAX_EVIDENCE_LOOP_BYTES) {
      await rm(candidate.absolute, { force: true });
      rejected.set(candidate.relative, `${candidate.bytes} bytes exceeds the remaining loop allowance`);
      notes.push(`evidence file removed (loop limit): ${candidate.relative} (${candidate.bytes} bytes)`);
      continue;
    }
    const contents = await readFile(candidate.absolute);
    if (contents.byteLength > MAX_EVIDENCE_FILE_BYTES) {
      await rm(candidate.absolute, { force: true });
      rejected.set(candidate.relative, `${contents.byteLength} bytes exceeds the ${MAX_EVIDENCE_FILE_BYTES}-byte file limit`);
      notes.push(`evidence file removed (file limit): ${candidate.relative} (${contents.byteLength} bytes)`);
      continue;
    }
    if (retainedBytes + contents.byteLength > MAX_EVIDENCE_LOOP_BYTES) {
      await rm(candidate.absolute, { force: true });
      rejected.set(candidate.relative, `${contents.byteLength} bytes exceeds the remaining loop allowance`);
      notes.push(`evidence file removed (loop limit): ${candidate.relative} (${contents.byteLength} bytes)`);
      continue;
    }
    const stored = { ...candidate, bytes: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") };
    files.set(candidate.relative, stored);
    retainedBytes += contents.byteLength;
  }
  return { directory, files, rejected, notes };
}

type ResolvedReference =
  | { kind: "file"; file: StoredFile }
  | { kind: "missing"; relative: string }
  | { kind: "unsafe" }
  | { kind: "ordinary" };

function resolveReference(value: string, directory: string, files: Map<string, StoredFile>): ResolvedReference {
  const raw = value.trim();
  if (!raw) return { kind: "ordinary" };
  let absolute: string;
  let explicitEvidencePath = false;
  if (path.isAbsolute(raw)) {
    absolute = path.resolve(raw);
    explicitEvidencePath = true;
  } else {
    const normalized = portable(raw);
    const relative = normalized.startsWith("evidence/") ? normalized.slice("evidence/".length) : normalized;
    explicitEvidencePath = normalized.startsWith("evidence/");
    absolute = path.resolve(directory, ...relative.split("/"));
  }
  const relative = path.relative(directory, absolute);
  if (!relative || relative === ".") {
    return explicitEvidencePath ? { kind: "missing", relative: "" } : { kind: "ordinary" };
  }
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return { kind: "unsafe" };
  const key = portable(relative);
  const file = files.get(key);
  if (file) return { kind: "file", file };
  return explicitEvidencePath ? { kind: "missing", relative: key } : { kind: "ordinary" };
}

function bindCheckFiles(check: CheckResult, inventory: EvidenceInventory, notes: string[]): CheckResult {
  const next = { ...check };
  for (const stream of ["stdout", "stderr"] as const) {
    const pathKey = `${stream}_path` as const;
    const hashKey = `${stream}_sha256` as const;
    const storedPath = next[pathKey];
    delete next[hashKey];
    if (!storedPath) continue;
    const reference = resolveReference(storedPath, inventory.directory, inventory.files);
    if (reference.kind === "file") {
      next[pathKey] = reference.file.relative;
      next[hashKey] = reference.file.sha256;
    } else {
      notes.push(`check ${check.name}: ${stream} evidence file unavailable: ${storedPath}`);
      delete next[pathKey];
    }
  }
  return next;
}

export function evidencePriority(relative: string): number {
  return relative.startsWith("checks/") ? 0 : 1;
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

function comparePortable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
