/** Bind one durable `.hoh` state to its historical candidate and role identities. */
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DeveloperRecord, Role, RunConfig } from "../types.js";
import { ROLES } from "../types.js";
import {
  captureRunReceiptArtifact,
  createRunReceipt,
  serializeRunReceipt,
  type CanonicalJsonValue,
  type RunReceipt,
  type RunReceiptCandidate,
  type RunReceiptVerificationIssue,
  type RunReceiptVerificationResult,
  verifyRunReceiptFile,
} from "./receipt.js";
import { git } from "./git.js";
import { parseLoopDirName, readJson, RunPaths } from "./state.js";

const RECEIPT_TEMPORARY_PREFIX = ".receipt.json.tmp-";
const GENERATED_RUN_VIEW = "README.md";

/** Reject symlinks and non-regular runtime entries before the runtime writes through any path. */
export async function assertSafeRunRecordLayout(paths: RunPaths): Promise<void> {
  let rootStat: Awaited<ReturnType<typeof lstat>>;
  try {
    rootStat = await lstat(paths.root);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink()) throw new Error("cannot use a symlink as the .hoh runtime root");
  if (!rootStat.isDirectory()) throw new Error(".hoh runtime root must be a directory");
  await listReceiptArtifactPaths(paths);
}

export async function refreshRunReceipt(paths: RunPaths, run: RunConfig): Promise<RunReceipt> {
  if (!run.protocol_receipt) throw new Error("cannot create run receipt without a protocol receipt");
  await mkdir(paths.root, { recursive: true });

  const relativeFiles = await listReceiptArtifactPaths(paths);
  const artifacts = [];
  for (const relativePath of relativeFiles) {
    artifacts.push(await captureRunReceiptArtifact(paths.workspace, relativePath, relativePath));
  }
  const protocol = run.protocol_receipt;
  const reportedModels = await latestReportedModels(paths);
  const roles = Object.fromEntries(
    ROLES.map((role) => [
      role,
      jsonValue({
        resolved_model: protocol.models[role],
        last_reported_model: reportedModels[role],
        contract: protocol.role_contracts[role],
      }),
    ]),
  ) as Record<Role, CanonicalJsonValue>;
  const receipt = createRunReceipt({
    run_id: run.run_id,
    artifacts,
    identities: {
      harness: {
        ...protocol.harness,
        protocol: protocol.mode,
        protocol_sha256: protocol.protocol_sha256,
        config_sha256: protocol.config_sha256,
        runtime_version: protocol.runtime_version,
      },
      roles,
    },
    candidate: await latestCandidate(paths),
  });
  await writeReceiptAtomically(paths.receipt, receipt);
  return receipt;
}

async function latestReportedModels(paths: RunPaths): Promise<Record<Role, string | null>> {
  const models: Record<Role, string | null> = { planner: null, developer: null, tester: null };
  let entries: string[];
  try {
    entries = await readdir(paths.iterations);
  } catch (error: any) {
    if (error?.code === "ENOENT") return models;
    throw error;
  }
  const loopIndexes = entries
    .map(parseLoopDirName)
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left);
  for (const loopIndex of loopIndexes) {
    const [planner, developer, evidence] = await Promise.all([
      models.planner ? null : readJson<{ usage?: { model?: string } }>(paths.plannerJson(loopIndex)),
      models.developer ? null : readJson<{ usage?: { model?: string } }>(paths.developerJson(loopIndex)),
      models.tester ? null : readJson<{ usage?: { model?: string } }>(paths.evidenceJson(loopIndex)),
    ]);
    if (!models.planner && planner?.usage?.model) models.planner = planner.usage.model;
    if (!models.developer && developer?.usage?.model) models.developer = developer.usage.model;
    if (!models.tester && evidence?.usage?.model) models.tester = evidence.usage.model;
    if (ROLES.every((role) => models[role] !== null)) break;
  }
  return models;
}

/** Verify both recorded hashes and the exact canonical `.hoh` file inventory. */
export async function verifyCurrentRunReceipt(workspace: string): Promise<RunReceiptVerificationResult> {
  const paths = new RunPaths(path.resolve(workspace));
  const verified = await verifyRunReceiptFile(paths.workspace);
  if (!verified.receipt) return verified;

  const issues: RunReceiptVerificationIssue[] = [...verified.issues];
  let currentPaths: string[];
  try {
    currentPaths = await listReceiptArtifactPaths(paths);
  } catch (error) {
    issues.push({
      code: "artifact_unexpected",
      message: `canonical run-record inventory is unsafe: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { ok: false, receipt: verified.receipt, issues };
  }
  const current = new Set(currentPaths);
  const recorded = new Set(verified.receipt.artifacts.map((artifact) => artifact.path));
  for (const relativePath of currentPaths) {
    if (!recorded.has(relativePath)) {
      issues.push({
        code: "artifact_unexpected",
        path: relativePath,
        message: `canonical run record is not listed in the receipt: ${relativePath}`,
      });
    }
  }
  for (const relativePath of [...recorded].sort()) {
    if (!current.has(relativePath) && !issues.some((issue) => issue.path === relativePath)) {
      issues.push({
        code: "artifact_unexpected",
        path: relativePath,
        message: `receipt lists a path outside the canonical run-record inventory: ${relativePath}`,
      });
    }
  }
  return { ok: issues.length === 0, receipt: verified.receipt, issues };
}

async function listReceiptArtifactPaths(paths: RunPaths): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`cannot receipt runtime symlink .hoh/${relative}`);
      const excludedRootView = !relativeDirectory && (entry.name === path.basename(paths.receipt) || entry.name === GENERATED_RUN_VIEW);
      if (excludedRootView) {
        if (!entry.isFile()) throw new Error(`cannot exclude non-regular runtime entry .hoh/${relative}`);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile()) throw new Error(`cannot receipt non-regular runtime entry .hoh/${relative}`);
      files.push(`.hoh/${relative}`);
    }
  };
  await visit(paths.root, "");
  return files.sort();
}

async function latestCandidate(paths: RunPaths): Promise<RunReceiptCandidate | null> {
  let entries: string[];
  try {
    entries = await readdir(paths.iterations);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const loopIndexes = entries
    .map(parseLoopDirName)
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left);
  for (const loopIndex of loopIndexes) {
    const developer = await readJson<DeveloperRecord>(paths.developerJson(loopIndex));
    if (!developer) continue;
    const commitOid = developer.candidate_commit_sha ?? developer.commit ?? developer.base_commit_sha;
    if (!commitOid) throw new Error(`cannot bind loop ${loopIndex} candidate: its historical Git endpoint was not recorded`);
    return {
      commit_oid: commitOid,
      tree_oid: developer.candidate_tree_sha,
      subdir: await candidateArtifactSubdir(paths, developer, commitOid),
    };
  }
  return null;
}

function jsonValue(value: unknown): CanonicalJsonValue {
  return JSON.parse(JSON.stringify(value)) as CanonicalJsonValue;
}

async function candidateArtifactSubdir(paths: RunPaths, developer: DeveloperRecord, commitOid: string): Promise<string> {
  if (developer.artifact_subdir) return canonicalArtifactSubdir(developer.artifact_subdir);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitOid)) {
    throw new Error(`cannot recover candidate artifact_dir from invalid commit object ID ${JSON.stringify(commitOid)}`);
  }
  const recorded = await git(["show", `${commitOid}:.hoh/config.json`], paths.workspace, { allowFail: true });
  if (recorded.code !== 0) {
    throw new Error(`cannot recover candidate artifact_dir from historical config at ${commitOid}`);
  }
  let config: { artifact_dir?: unknown };
  try {
    config = JSON.parse(recorded.stdout) as { artifact_dir?: unknown };
  } catch {
    throw new Error(`cannot recover candidate artifact_dir: historical config at ${commitOid} is invalid JSON`);
  }
  if (typeof config.artifact_dir !== "string") {
    throw new Error(`cannot recover candidate artifact_dir: historical config at ${commitOid} has no artifact_dir`);
  }
  return canonicalArtifactSubdir(config.artifact_dir);
}

function canonicalArtifactSubdir(value: string): string {
  if (value.includes("\\")) throw new Error(`artifact_dir is not a canonical POSIX path: ${JSON.stringify(value)}`);
  return path.posix.normalize(value);
}

async function writeReceiptAtomically(filename: string, receipt: RunReceipt): Promise<void> {
  const temporary = path.join(path.dirname(filename), `${RECEIPT_TEMPORARY_PREFIX}${process.pid}-${Date.now()}`);
  try {
    await writeFile(temporary, serializeRunReceipt(receipt), { mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}
