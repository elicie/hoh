/** Durable, bounded files collected by deterministic checks and the QA Tester. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { CheckResult, ClaimCatalog, ClaimRecord, EvidenceBundle, ExecutionRecord } from "../types.js";
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
export async function bindEvidenceFiles(bundle: EvidenceBundle, directory: string, catalog?: ClaimCatalog): Promise<EvidenceBundle> {
  const inventory = await inventoryEvidence(directory);
  const runtimeNotes = [...bundle.runtime_notes, ...inventory.notes];
  const unusableRecords = new WeakSet<ExecutionRecord>();

  const bindRecord = (claimId: string, record: ExecutionRecord): ExecutionRecord => {
    const { sha256: _submittedHash, ...withoutHash } = record;
    if (!record.path) return withoutHash;
    const reference = resolveReference(record.path, directory, inventory.files);
    if (reference.kind === "file") {
      return { ...withoutHash, path: reference.file.relative, sha256: reference.file.sha256 };
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
    if (reference.kind !== "ordinary" || FILE_BACKED_TYPES.has(record.type)) unusableRecords.add(withoutHash);
    return withoutHash;
  };

  const bindClaims = (records: EvidenceBundle["verified_records"]): EvidenceBundle["verified_records"] =>
    records.map((record) => ({
      ...record,
      execution_records: record.execution_records.map((execution) => bindRecord(record.claim_id, execution)),
    }));

  const fixedClaims = new Map(catalog?.claims.map((claim) => [claim.id, claim]) ?? []);
  const boundVerified = bindClaims(bundle.verified_records);
  const downgraded: ClaimRecord[] = [];
  const verified = boundVerified.filter((record) => {
    const usableTypes = new Set(
      record.execution_records
        .filter((execution) => !unusableRecords.has(execution) && (!FILE_BACKED_TYPES.has(execution.type) || Boolean(execution.sha256)))
        .map((execution) => execution.type),
    );
    const hasExecution = EXECUTION_EVIDENCE_TYPES.some((type) => usableTypes.has(type));
    const missingRequired = (fixedClaims.get(record.claim_id)?.requires ?? []).filter((type) => !usableTypes.has(type));
    if (hasExecution && missingRequired.length === 0) return true;
    downgraded.push({ ...record, status: "gap", severity: record.severity ?? "minor" });
    runtimeNotes.push(
      `claim ${record.claim_id}: retained evidence files do not satisfy ${missingRequired.length ? `required types ${missingRequired.join(", ")}` : "the execution-evidence requirement"}; downgraded to gap`,
    );
    return false;
  });

  const gapRecords = [...bindClaims(bundle.gap_records), ...downgraded];
  const checks = bundle.checks.map((check) => bindCheckFiles(check, inventory, runtimeNotes));
  const checksFailed = checks.some((check) => check.status !== "pass");
  const qaStatus =
    bundle.qa_status === "fail" || !bundle.frozen || checksFailed || gapRecords.some((record) => record.severity === "blocker") || verified.length === 0
      ? "fail"
      : bundle.qa_status === "partial" || gapRecords.length
        ? "partial"
        : "pass";
  return {
    ...bundle,
    qa_status: qaStatus,
    verified_records: verified,
    gap_records: gapRecords,
    checks,
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

function evidencePriority(relative: string): number {
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
