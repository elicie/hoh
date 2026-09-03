/** Canonical, offline-verifiable run receipt primitives. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, canonicalSha256 } from "./protocol.js";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface RunReceiptArtifact {
  readonly name: string;
  /** Canonical workspace-relative path to a regular file. */
  readonly path: string;
  readonly sha256: string;
}

export interface RunReceiptCandidate {
  /** Full Git commit object ID, not a ref or abbreviated ID. */
  readonly commit_oid: string;
  /** Git tree object ID produced with artifactTreeHash semantics. */
  readonly tree_oid: string;
  /** Canonical workspace-relative artifact directory, or `.` for the root. */
  readonly subdir: string;
}

export interface RunReceiptIdentities {
  /** Adapter-defined canonical identity (for example name/version/model resolution). */
  readonly harness: CanonicalJsonValue;
  /** Role names map to adapter-defined canonical identities. */
  readonly roles: Readonly<Record<string, CanonicalJsonValue>>;
}

export interface RunReceiptInput {
  readonly run_id: string;
  readonly artifacts: readonly RunReceiptArtifact[];
  readonly identities: RunReceiptIdentities;
  readonly candidate: RunReceiptCandidate | null;
}

export interface RunReceipt extends RunReceiptInput {
  readonly schema_version: 1;
  /** Canonical checksum; authenticity still requires trusted storage or signing. */
  readonly receipt_sha256: string;
}

export type RunReceiptVerificationCode =
  | "receipt_missing"
  | "receipt_unreadable"
  | "receipt_symlink"
  | "receipt_not_file"
  | "receipt_too_large"
  | "receipt_unsafe_path"
  | "receipt_invalid_json"
  | "receipt_malformed"
  | "receipt_integrity_mismatch"
  | "artifact_missing"
  | "artifact_unreadable"
  | "artifact_symlink"
  | "artifact_not_file"
  | "artifact_hash_mismatch"
  | "candidate_commit_missing"
  | "candidate_commit_invalid"
  | "candidate_repository_invalid"
  | "candidate_git_error"
  | "candidate_tree_mismatch";

export interface RunReceiptVerificationIssue {
  readonly code: RunReceiptVerificationCode;
  readonly message: string;
  readonly artifact_name?: string;
  readonly path?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface RunReceiptVerificationResult {
  readonly ok: boolean;
  readonly receipt: RunReceipt | null;
  readonly issues: readonly RunReceiptVerificationIssue[];
}

type ReceiptValidationCode = "malformed" | "integrity_mismatch" | "unsafe_path";

export class RunReceiptValidationError extends Error {
  override readonly name = "RunReceiptValidationError";

  constructor(
    readonly code: ReceiptValidationCode,
    message: string,
  ) {
    super(message);
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_CANONICAL_DEPTH = 100;
export const MAX_RUN_RECEIPT_BYTES = 8 * 1024 * 1024;

/** Build a detached, deterministic receipt. Artifact ordering is canonicalized. */
export function createRunReceipt(value: unknown): RunReceipt {
  const raw = record(value, "receipt input");
  exactKeys(raw, ["run_id", "artifacts", "identities", "candidate"], "receipt input");
  const payload = parsePayload({ schema_version: 1, ...raw }, "receipt", true);
  return deepFreeze({ ...payload, receipt_sha256: canonicalSha256(payload) });
}

/** Strictly parse a stored receipt and verify its canonical self-hash. */
export function parseRunReceipt(value: unknown): RunReceipt {
  const raw = record(value, "receipt");
  exactKeys(raw, ["schema_version", "run_id", "artifacts", "identities", "candidate", "receipt_sha256"], "receipt");
  const receiptSha256 = sha256(raw.receipt_sha256, "receipt.receipt_sha256");
  const payloadValue = { ...raw };
  delete payloadValue.receipt_sha256;
  const payload = parsePayload(payloadValue, "receipt", false);
  const actual = canonicalSha256(payload);
  if (actual !== receiptSha256) {
    throw new RunReceiptValidationError(
      "integrity_mismatch",
      `receipt failed its integrity check (${receiptSha256.slice(0, 12)} != ${actual.slice(0, 12)})`,
    );
  }
  return deepFreeze({ ...payload, receipt_sha256: receiptSha256 });
}

/** Canonical JSON encoding suitable for durable receipt storage. */
export function serializeRunReceipt(receiptValue: unknown): string {
  return `${canonicalJson(parseRunReceipt(receiptValue))}\n`;
}

/**
 * Hash one regular file and return a receipt-ready named artifact.
 *
 * Portable Node does not expose openat2-style beneath traversal. The caller
 * must keep the workspace quiescent; this rejects static symlinks and detects
 * path/file changes before and after the bounded read, but is not an atomic
 * boundary against a hostile concurrent filesystem writer.
 */
export async function captureRunReceiptArtifact(
  workspace: string,
  nameValue: string,
  relativePathValue: string,
): Promise<RunReceiptArtifact> {
  const name = receiptName(nameValue, "artifact.name");
  const relativePath = receiptPath(relativePathValue, "artifact.path", false);
  return deepFreeze({ name, path: relativePath, sha256: await hashSafeRegularFile(workspace, relativePath) });
}

/**
 * Verify receipt structure, self-integrity, artifact bytes, and the historical
 * candidate. This function reads only the filesystem and local Git objects.
 * Artifact verification has the same quiescent-workspace prerequisite as
 * captureRunReceiptArtifact.
 */
export async function verifyRunReceipt(workspace: string, value: unknown): Promise<RunReceiptVerificationResult> {
  let receipt: RunReceipt;
  try {
    receipt = parseRunReceipt(value);
  } catch (error) {
    return verificationFailure(issueForReceiptValidation(error));
  }

  const issues: RunReceiptVerificationIssue[] = [];
  for (const artifact of receipt.artifacts) {
    try {
      const actual = await hashSafeRegularFile(workspace, artifact.path);
      if (actual !== artifact.sha256) {
        issues.push({
          code: "artifact_hash_mismatch",
          artifact_name: artifact.name,
          path: artifact.path,
          expected: artifact.sha256,
          actual,
          message: `artifact ${JSON.stringify(artifact.name)} failed its SHA-256 check`,
        });
      }
    } catch (error) {
      issues.push(issueForArtifactRead(error, artifact));
    }
  }

  if (receipt.candidate) {
    try {
      const actual = await historicalCandidateTreeOid(workspace, receipt.candidate);
      if (actual !== receipt.candidate.tree_oid) {
        issues.push({
          code: "candidate_tree_mismatch",
          expected: receipt.candidate.tree_oid,
          actual,
          message: `historical candidate tree does not match commit ${receipt.candidate.commit_oid}`,
        });
      }
    } catch (error) {
      issues.push(issueForHistoricalCandidate(error));
    }
  }

  return deepFreeze({ ok: issues.length === 0, receipt, issues });
}

/** Read and verify a workspace-relative receipt without consulting runtime config or providers. */
export async function verifyRunReceiptFile(
  workspace: string,
  relativePathValue = ".hoh/receipt.json",
): Promise<RunReceiptVerificationResult> {
  let relativePath: string;
  try {
    relativePath = receiptPath(relativePathValue, "receipt path", false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return verificationFailure({ code: "receipt_unsafe_path", path: relativePathValue, message });
  }

  let bytes: Buffer;
  try {
    bytes = await readSafeRegularFile(workspace, relativePath, MAX_RUN_RECEIPT_BYTES);
  } catch (error) {
    const safe = asSafeFileError(error);
    const code: RunReceiptVerificationCode =
      safe.code === "missing"
        ? "receipt_missing"
        : safe.code === "symlink"
          ? "receipt_symlink"
          : safe.code === "not_file"
            ? "receipt_not_file"
            : safe.code === "too_large"
              ? "receipt_too_large"
              : "receipt_unreadable";
    return verificationFailure({ code, path: relativePath, message: safe.message });
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return verificationFailure({
      code: "receipt_invalid_json",
      path: relativePath,
      message: `receipt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return verifyRunReceipt(workspace, value);
}

/**
 * Reconstruct artifactTreeHash for a recorded commit without reading or
 * changing the current index or working tree. Root `.hoh` is always excluded.
 */
export async function historicalCandidateTreeOid(workspace: string, candidateValue: unknown): Promise<string> {
  const candidate = parseCandidate(candidateValue, "candidate");
  if (!candidate) throw new RunReceiptValidationError("malformed", "candidate must not be null");

  let repository: string;
  try {
    repository = await realpath(workspace);
  } catch (error) {
    throw new HistoricalCandidateError("repository_invalid", `candidate workspace is unavailable: ${errorMessage(error)}`);
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), "hoh-receipt-index-"));
  const indexFile = path.join(temporary, "index");
  const globalConfig = path.join(temporary, "global.gitconfig");
  const temporaryObjects = path.join(temporary, "objects");
  await writeFile(globalConfig, "");
  await mkdir(temporaryObjects);
  const baseGitEnvironment = {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_INDEX_FILE: indexFile,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    LC_ALL: "C",
  };

  try {
    const top = await runOfflineGit(repository, ["rev-parse", "--show-toplevel"], baseGitEnvironment, true);
    if (top.code !== 0) {
      throw new HistoricalCandidateError("repository_invalid", `candidate workspace is not a readable Git repository: ${diagnostic(top)}`);
    }
    let topLevel: string;
    try {
      topLevel = await realpath(top.stdout.trim());
    } catch (error) {
      throw new HistoricalCandidateError("repository_invalid", `candidate repository root is unavailable: ${errorMessage(error)}`);
    }
    if (topLevel !== repository) {
      throw new HistoricalCandidateError("repository_invalid", "candidate workspace must be the Git repository root");
    }

    const objectPath = await runOfflineGit(repository, ["rev-parse", "--git-path", "objects"], baseGitEnvironment, true);
    if (objectPath.code !== 0 || !objectPath.stdout.trim()) {
      throw new HistoricalCandidateError("repository_invalid", `candidate object database is unavailable: ${diagnostic(objectPath)}`);
    }
    let realObjects: string;
    try {
      const configuredObjects = objectPath.stdout.trim();
      realObjects = await realpath(path.isAbsolute(configuredObjects) ? configuredObjects : path.resolve(repository, configuredObjects));
    } catch (error) {
      throw new HistoricalCandidateError("repository_invalid", `candidate object database is unavailable: ${errorMessage(error)}`);
    }
    const gitEnvironment = {
      ...baseGitEnvironment,
      GIT_OBJECT_DIRECTORY: temporaryObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirectory(realObjects),
    };

    const objectType = await runOfflineGit(repository, ["cat-file", "-t", candidate.commit_oid], gitEnvironment, true);
    if (objectType.code !== 0) {
      throw new HistoricalCandidateError(
        "commit_missing",
        `recorded candidate commit ${candidate.commit_oid} is unavailable in the local repository`,
      );
    }
    if (objectType.stdout.trim() !== "commit") {
      throw new HistoricalCandidateError(
        "commit_invalid",
        `recorded candidate OID ${candidate.commit_oid} names ${objectType.stdout.trim() || "an unknown object"}, not a commit object`,
      );
    }

    const loaded = await runOfflineGit(repository, ["read-tree", "--reset", candidate.commit_oid], gitEnvironment, true);
    if (loaded.code !== 0) {
      throw new HistoricalCandidateError("git_error", `could not read recorded candidate commit: ${diagnostic(loaded)}`);
    }

    if (candidate.subdir === ".") {
      const excluded = await runOfflineGit(
        repository,
        ["rm", "-r", "-f", "-q", "--cached", "--ignore-unmatch", "--", ".hoh"],
        gitEnvironment,
        true,
      );
      if (excluded.code !== 0) {
        throw new HistoricalCandidateError("git_error", `could not exclude .hoh from the candidate tree: ${diagnostic(excluded)}`);
      }
    }

    if (candidate.subdir !== ".") {
      const entry = await runOfflineGit(
        repository,
        ["ls-tree", "-z", "--full-tree", candidate.commit_oid, "--", candidate.subdir],
        gitEnvironment,
        true,
      );
      if (entry.code !== 0) {
        throw new HistoricalCandidateError("git_error", `could not inspect candidate subdir: ${diagnostic(entry)}`);
      }
      // `hash-object` must see the repository's native object format; the
      // isolated write directory is intentionally format-agnostic.
      if (!entry.stdout) return emptyTreeOid(repository, baseGitEnvironment);
      const parsed = parseLsTreeEntry(entry.stdout, candidate.subdir);
      if (parsed.type !== "tree") {
        throw new HistoricalCandidateError("git_error", `candidate subdir ${JSON.stringify(candidate.subdir)} is not a Git tree`);
      }
      return parsed.oid;
    }

    const written = await runOfflineGit(repository, ["write-tree"], gitEnvironment, true);
    if (written.code !== 0) {
      throw new HistoricalCandidateError("git_error", `could not reconstruct candidate tree: ${diagnostic(written)}`);
    }
    const treeOid = written.stdout.trim();
    if (!GIT_OID.test(treeOid)) {
      throw new HistoricalCandidateError("git_error", `Git returned an invalid tree object ID: ${JSON.stringify(treeOid)}`);
    }
    return treeOid;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

interface RunReceiptPayload extends RunReceiptInput {
  readonly schema_version: 1;
}

function parsePayload(value: unknown, at: string, canonicalizeArtifactOrder: boolean): RunReceiptPayload {
  const raw = record(value, at);
  exactKeys(raw, ["schema_version", "run_id", "artifacts", "identities", "candidate"], at);
  if (raw.schema_version !== 1) malformed(`${at}.schema_version must be 1`);
  const payload: RunReceiptPayload = {
    schema_version: 1,
    run_id: receiptName(raw.run_id, `${at}.run_id`),
    artifacts: parseArtifacts(raw.artifacts, `${at}.artifacts`, canonicalizeArtifactOrder),
    identities: parseIdentities(raw.identities, `${at}.identities`),
    candidate: parseCandidate(raw.candidate, `${at}.candidate`),
  };
  return deepFreeze(payload);
}

function parseArtifacts(value: unknown, at: string, canonicalizeOrder: boolean): readonly RunReceiptArtifact[] {
  if (!Array.isArray(value)) malformed(`${at} must be an array`);
  assertDenseArray(value, at);
  const artifacts = value.map((item, index) => {
    const raw = record(item, `${at}[${index}]`);
    exactKeys(raw, ["name", "path", "sha256"], `${at}[${index}]`);
    return {
      name: receiptName(raw.name, `${at}[${index}].name`),
      path: receiptPath(raw.path, `${at}[${index}].path`, false),
      sha256: sha256(raw.sha256, `${at}[${index}].sha256`),
    };
  });
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (names.has(artifact.name)) malformed(`${at} duplicates artifact name ${JSON.stringify(artifact.name)}`);
    if (paths.has(artifact.path)) malformed(`${at} duplicates artifact path ${JSON.stringify(artifact.path)}`);
    names.add(artifact.name);
    paths.add(artifact.path);
  }
  const sorted = [...artifacts].sort(compareArtifacts);
  if (artifacts.some((artifact, index) => compareArtifacts(artifact, sorted[index]) !== 0)) {
    if (!canonicalizeOrder) malformed(`${at} must be sorted by artifact name and path`);
    artifacts.splice(0, artifacts.length, ...sorted);
  }
  return deepFreeze(artifacts);
}

function compareArtifacts(a: RunReceiptArtifact, b: RunReceiptArtifact): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function parseIdentities(value: unknown, at: string): RunReceiptIdentities {
  const raw = record(value, at);
  exactKeys(raw, ["harness", "roles"], at);
  const roleValues = record(raw.roles, `${at}.roles`);
  const roles = Object.fromEntries(
    Object.keys(roleValues)
      .sort()
      .map((role) => [receiptName(role, `${at}.roles key`), canonicalValue(roleValues[role], `${at}.roles.${role}`)]),
  );
  return deepFreeze({ harness: canonicalValue(raw.harness, `${at}.harness`), roles });
}

function parseCandidate(value: unknown, at: string): RunReceiptCandidate | null {
  if (value === null) return null;
  const raw = record(value, at);
  exactKeys(raw, ["commit_oid", "tree_oid", "subdir"], at);
  const commitOid = gitOid(raw.commit_oid, `${at}.commit_oid`);
  const treeOid = gitOid(raw.tree_oid, `${at}.tree_oid`);
  if (commitOid.length !== treeOid.length) malformed(`${at} object IDs must use the same Git object format`);
  const subdir = receiptPath(raw.subdir, `${at}.subdir`, true);
  if (subdir === ".hoh" || subdir.startsWith(".hoh/")) {
    throw new RunReceiptValidationError("unsafe_path", `${at}.subdir must not select runtime-owned .hoh`);
  }
  return deepFreeze({ commit_oid: commitOid, tree_oid: treeOid, subdir });
}

function canonicalValue(value: unknown, at: string, stack = new WeakSet<object>(), depth = 0): CanonicalJsonValue {
  if (depth > MAX_CANONICAL_DEPTH) malformed(`${at} exceeds the maximum canonical JSON depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) malformed(`${at} must be a finite JSON number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== "object") malformed(`${at} must contain only canonical JSON values`);
  if (stack.has(value)) malformed(`${at} must not contain a cycle`);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseArray(value, at);
      return deepFreeze(value.map((item, index) => canonicalValue(item, `${at}[${index}]`, stack, depth + 1)));
    }
    const raw = record(value, at);
    const entries = Object.keys(raw)
      .sort()
      .map((key) => [key, canonicalValue(raw[key], `${at}.${key}`, stack, depth + 1)] as const);
    return deepFreeze(Object.fromEntries(entries));
  } finally {
    stack.delete(value);
  }
}

function receiptName(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || CONTROL_CHARACTER.test(value)) {
    malformed(`${at} must be a non-empty, trimmed string without control characters`);
  }
  return value;
}

function receiptPath(value: unknown, at: string, allowDot: boolean): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || CONTROL_CHARACTER.test(value)) {
    throw new RunReceiptValidationError("unsafe_path", `${at} must be a canonical workspace-relative POSIX path`);
  }
  if (value === ".") {
    if (allowDot) return value;
    throw new RunReceiptValidationError("unsafe_path", `${at} must name a file, not the workspace root`);
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new RunReceiptValidationError("unsafe_path", `${at} must be relative to the workspace`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || path.posix.normalize(value) !== value) {
    throw new RunReceiptValidationError("unsafe_path", `${at} must stay inside the workspace without traversal`);
  }
  return value;
}

function sha256(value: unknown, at: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) malformed(`${at} must be a lowercase 64-character SHA-256`);
  return value;
}

function gitOid(value: unknown, at: string): string {
  if (typeof value !== "string" || !GIT_OID.test(value)) {
    malformed(`${at} must be a full lowercase SHA-1 or SHA-256 Git object ID`);
  }
  return value;
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed(`${at} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) malformed(`${at} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) malformed(`${at} must not contain symbol keys`);
  return value as Record<string, unknown>;
}

function exactKeys(raw: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(raw).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    malformed(`${at} must contain exactly: ${expected.join(", ")}`);
  }
}

function malformed(message: string): never {
  throw new RunReceiptValidationError("malformed", message);
}

function assertDenseArray(value: readonly unknown[], at: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) malformed(`${at} must not contain sparse array holes`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

type SafeFileCode = "missing" | "symlink" | "not_file" | "outside" | "changed" | "too_large" | "unreadable";

class SafeFileError extends Error {
  override readonly name = "SafeFileError";

  constructor(
    readonly code: SafeFileCode,
    message: string,
  ) {
    super(message);
  }
}

async function withSafeRegularFile<T>(
  workspace: string,
  relativePath: string,
  consume: (handle: FileHandle, opened: BigIntStats) => Promise<T>,
): Promise<T> {
  let root: string;
  try {
    root = await realpath(workspace);
  } catch (error) {
    throw new SafeFileError("missing", `workspace is unavailable: ${errorMessage(error)}`);
  }

  const inspected = await inspectRegularFilePath(root, relativePath);
  let handle: FileHandle;
  try {
    handle = await open(inspected.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: any) {
    if (error?.code === "ELOOP") throw new SafeFileError("symlink", `symlink paths are not allowed: ${relativePath}`);
    if (error?.code === "ENOENT") throw new SafeFileError("missing", `file is missing: ${relativePath}`);
    throw new SafeFileError("unreadable", `cannot open ${relativePath}: ${errorMessage(error)}`);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new SafeFileError("not_file", `artifact is not a regular file: ${relativePath}`);
    if (!sameFileIdentity(opened, inspected.stat)) {
      throw new SafeFileError("changed", `path changed while it was being verified: ${relativePath}`);
    }
    const result = await consume(handle, opened);
    const afterRead = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(opened, afterRead)) {
      throw new SafeFileError("changed", `file changed while it was being verified: ${relativePath}`);
    }
    const afterPath = await inspectRegularFilePath(root, relativePath);
    if (!sameFileIdentity(opened, afterPath.stat)) {
      throw new SafeFileError("changed", `path changed while it was being verified: ${relativePath}`);
    }
    return result;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function inspectRegularFilePath(root: string, relativePath: string): Promise<{ absolute: string; stat: BigIntStats }> {
  let current = root;
  let finalStat: BigIntStats | null = null;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    try {
      finalStat = await lstat(current, { bigint: true });
    } catch (error: any) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw new SafeFileError("missing", `file is missing: ${relativePath}`);
      }
      throw new SafeFileError("unreadable", `cannot inspect ${relativePath}: ${errorMessage(error)}`);
    }
    if (finalStat.isSymbolicLink()) throw new SafeFileError("symlink", `symlink paths are not allowed: ${relativePath}`);
    if (index < segments.length - 1 && !finalStat.isDirectory()) {
      throw new SafeFileError("not_file", `path ancestor is not a directory: ${relativePath}`);
    }
  }
  if (!finalStat?.isFile()) throw new SafeFileError("not_file", `artifact is not a regular file: ${relativePath}`);

  let resolved: string;
  try {
    resolved = await realpath(current);
  } catch (error) {
    throw new SafeFileError("unreadable", `cannot resolve ${relativePath}: ${errorMessage(error)}`);
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new SafeFileError("outside", `path resolves outside the workspace: ${relativePath}`);
  }
  return { absolute: current, stat: finalStat };
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function hashSafeRegularFile(workspace: string, relativePath: string): Promise<string> {
  return withSafeRegularFile(workspace, relativePath, async (handle, opened) => {
    const hash = createHash("sha256");
    await consumeObservedBytes(handle, opened.size, (bytes) => hash.update(bytes));
    return hash.digest("hex");
  });
}

async function readSafeRegularFile(workspace: string, relativePath: string, maxBytes: number): Promise<Buffer> {
  return withSafeRegularFile(workspace, relativePath, async (handle, opened) => {
    if (opened.size > BigInt(maxBytes)) {
      throw new SafeFileError("too_large", `file exceeds the ${maxBytes}-byte verification limit: ${relativePath}`);
    }
    const chunks: Buffer[] = [];
    await consumeObservedBytes(handle, opened.size, (bytes) => chunks.push(Buffer.from(bytes)));
    return Buffer.concat(chunks, Number(opened.size));
  });
}

async function consumeObservedBytes(
  handle: FileHandle,
  observedSize: bigint,
  consume: (bytes: Uint8Array) => void,
): Promise<void> {
  let position = 0n;
  while (position < observedSize) {
    const length = Number(observedSize - position > 64n * 1024n ? 64n * 1024n : observedSize - position);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) throw new SafeFileError("changed", "file was truncated while it was being verified");
    consume(buffer.subarray(0, bytesRead));
    position += BigInt(bytesRead);
  }
  const probe = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(probe, 0, 1, observedSize);
  if (bytesRead !== 0) throw new SafeFileError("changed", "file grew while it was being verified");
}

function asSafeFileError(error: unknown): SafeFileError {
  return error instanceof SafeFileError ? error : new SafeFileError("unreadable", errorMessage(error));
}

function issueForArtifactRead(error: unknown, artifact: RunReceiptArtifact): RunReceiptVerificationIssue {
  const safe = asSafeFileError(error);
  const code: RunReceiptVerificationCode =
    safe.code === "missing"
      ? "artifact_missing"
      : safe.code === "symlink" || safe.code === "outside"
        ? "artifact_symlink"
        : safe.code === "not_file"
          ? "artifact_not_file"
          : "artifact_unreadable";
  return { code, artifact_name: artifact.name, path: artifact.path, message: safe.message };
}

function issueForReceiptValidation(error: unknown): RunReceiptVerificationIssue {
  if (error instanceof RunReceiptValidationError) {
    const code: RunReceiptVerificationCode =
      error.code === "integrity_mismatch"
        ? "receipt_integrity_mismatch"
        : error.code === "unsafe_path"
          ? "receipt_unsafe_path"
          : "receipt_malformed";
    return { code, message: error.message };
  }
  return { code: "receipt_malformed", message: errorMessage(error) };
}

type HistoricalCandidateCode = "commit_missing" | "commit_invalid" | "repository_invalid" | "git_error";

class HistoricalCandidateError extends Error {
  override readonly name = "HistoricalCandidateError";

  constructor(
    readonly code: HistoricalCandidateCode,
    message: string,
  ) {
    super(message);
  }
}

function issueForHistoricalCandidate(error: unknown): RunReceiptVerificationIssue {
  if (error instanceof HistoricalCandidateError) {
    const code: RunReceiptVerificationCode =
      error.code === "commit_missing"
        ? "candidate_commit_missing"
        : error.code === "commit_invalid"
          ? "candidate_commit_invalid"
        : error.code === "repository_invalid"
            ? "candidate_repository_invalid"
            : "candidate_git_error";
    return { code, message: error.message };
  }
  if (error instanceof RunReceiptValidationError) return { code: "receipt_malformed", message: error.message };
  return { code: "candidate_git_error", message: errorMessage(error) };
}

function verificationFailure(issue: RunReceiptVerificationIssue): RunReceiptVerificationResult {
  return deepFreeze({ ok: false, receipt: null, issues: [issue] });
}

interface OfflineGitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function parseLsTreeEntry(output: string, expectedPath: string): { type: string; oid: string } {
  const entries = output.split("\0").filter(Boolean);
  if (entries.length !== 1) {
    throw new HistoricalCandidateError("git_error", `Git returned ambiguous metadata for candidate subdir ${JSON.stringify(expectedPath)}`);
  }
  const separator = entries[0].indexOf("\t");
  const header = separator >= 0 ? entries[0].slice(0, separator).split(" ") : [];
  const returnedPath = separator >= 0 ? entries[0].slice(separator + 1) : "";
  if (header.length !== 3 || !/^[0-7]{6}$/.test(header[0]) || !GIT_OID.test(header[2]) || returnedPath !== expectedPath) {
    throw new HistoricalCandidateError("git_error", `Git returned malformed metadata for candidate subdir ${JSON.stringify(expectedPath)}`);
  }
  return { type: header[1], oid: header[2] };
}

async function emptyTreeOid(repository: string, environment: Readonly<Record<string, string>>): Promise<string> {
  const result = await runOfflineGit(repository, ["hash-object", "-t", "tree", "--stdin"], environment, true);
  const oid = result.stdout.trim();
  if (result.code !== 0 || !GIT_OID.test(oid)) {
    throw new HistoricalCandidateError("git_error", `could not derive the repository's empty tree object ID: ${diagnostic(result)}`);
  }
  return oid;
}

function alternateObjectDirectory(directory: string): string {
  return directory.includes(path.delimiter) || directory.startsWith('"') ? JSON.stringify(directory) : directory;
}

function runOfflineGit(
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  allowFailure = false,
): Promise<OfflineGitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-replace-objects", ...args], {
      cwd,
      env: { ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? -1, stdout, stderr };
      if (result.code !== 0 && !allowFailure) reject(new HistoricalCandidateError("git_error", diagnostic(result)));
      else resolve(result);
    });
  });
}

function diagnostic(result: OfflineGitResult): string {
  return (result.stderr || result.stdout).trim() || `git exited ${result.code}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
