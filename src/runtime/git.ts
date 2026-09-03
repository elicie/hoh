/**
 * Git operations used by the runtime: artifact identity (tree hash), role
 * commits, and isolated worktrees for the QA Tester.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Role } from "../types.js";

export interface GitIdentity {
  name: string;
  email: string;
}

export const RUNTIME_IDENTITY: GitIdentity = { name: "hoh-runtime", email: "hoh-runtime@users.noreply.local" };
export const ROLE_IDENTITY: Record<Role, GitIdentity> = {
  planner: { name: "hoh-planner-bot", email: "hoh-planner-bot@users.noreply.local" },
  developer: { name: "hoh-developer-bot", email: "hoh-developer-bot@users.noreply.local" },
  tester: { name: "hoh-tester-bot", email: "hoh-tester-bot@users.noreply.local" },
};

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(
  args: string[],
  cwd: string,
  opts: { env?: Record<string, string>; allowFail?: boolean } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? -1, stdout, stderr };
      if (result.code !== 0 && !opts.allowFail) {
        reject(new Error(`git ${args.join(" ")} failed (${result.code}) in ${cwd}: ${stderr.trim() || stdout.trim()}`));
      } else {
        resolve(result);
      }
    });
  });
}

function identityEnv(id: GitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: id.name,
    GIT_AUTHOR_EMAIL: id.email,
    GIT_COMMITTER_NAME: id.name,
    GIT_COMMITTER_EMAIL: id.email,
  };
}

/** Make `dir` the top level of a git repository (initializing one if needed). */
export async function ensureRepo(dir: string): Promise<void> {
  const top = await git(["rev-parse", "--show-toplevel"], dir, { allowFail: true });
  if (top.code === 0 && path.resolve(top.stdout.trim()) === path.resolve(dir)) return;
  await git(["init", "-q"], dir);
}

export async function headCommit(dir: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "-q", "HEAD"], dir, { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** True when a working-tree path exists at HEAD and has the same content. */
export async function pathMatchesHead(dir: string, relativePath: string): Promise<boolean> {
  const tracked = await git(["cat-file", "-e", `HEAD:${relativePath}`], dir, { allowFail: true });
  if (tracked.code !== 0) return false;
  const unchanged = await git(["diff", "--quiet", "HEAD", "--", relativePath], dir, { allowFail: true });
  return unchanged.code === 0;
}

/** Stage `pathspec` (default: everything) and commit as `identity`. Returns the commit or null when nothing changed. */
export async function commitAll(
  dir: string,
  message: string,
  identity: GitIdentity,
  pathspec: string[] = ["."],
): Promise<string | null> {
  await git(["add", "-A", "--", ...pathspec], dir, { allowFail: true });
  const staged = await git(["diff", "--cached", "--quiet"], dir, { allowFail: true });
  if (staged.code === 0) return null;
  await git(["commit", "-q", "--no-verify", "-m", message], dir, { env: identityEnv(identity) });
  return headCommit(dir);
}

/**
 * Content hash of the artifact: a git tree object built from the working
 * directory (respecting .gitignore) with `excludes` removed. Two directories
 * with identical file contents produce identical hashes.
 */
/** git's hash of the empty tree */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export async function artifactTreeHash(dir: string, opts: { subdir?: string; excludes?: string[] } = {}): Promise<string> {
  const excludes = opts.excludes ?? [".hoh"];
  const subdir = opts.subdir && opts.subdir !== "." ? opts.subdir.replace(/\/+$/, "") : undefined;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hoh-index-"));
  const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
  try {
    await git(["add", "-A", "--", subdir ?? ".", ...excludes.map((e) => `:(exclude)${e}`)], dir, { env, allowFail: true });
    const r = await git(subdir ? ["write-tree", `--prefix=${subdir}/`] : ["write-tree"], dir, { env, allowFail: true });
    return r.code === 0 ? r.stdout.trim() : EMPTY_TREE;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function changedPaths(dir: string, from: string | null, to: string): Promise<string[]> {
  const r = from
    ? await git(["diff", "--name-only", from, to], dir)
    : await git(["ls-tree", "-r", "--name-only", to], dir);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Paths under `pathspec` with uncommitted changes (staged, unstaged, or untracked). */
export async function pathsChanged(dir: string, pathspec: string[], opts: { includeIgnored?: boolean } = {}): Promise<string[]> {
  const r = await git(
    ["status", "--porcelain", "--untracked-files=all", ...(opts.includeIgnored ? ["--ignored=matching"] : []), "--", ...pathspec],
    dir,
  );
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
}

/** Discard every uncommitted change under `pathspec`. */
export async function restorePaths(dir: string, pathspec: string[], opts: { includeIgnored?: boolean } = {}): Promise<void> {
  // Reset the index first. `checkout -- <path>` alone copies a staged blob
  // back into the working tree, so a role could otherwise stage a protected
  // edit and let a later commit pick it up. Resolve the remaining tracked
  // changes after the reset so unmatched untracked literals cannot make one
  // combined checkout abort before restoring valid paths.
  await git(["reset", "-q", "HEAD", "--", ...pathspec], dir, { allowFail: true });
  const tracked = await git(["diff", "--name-only", "-z", "--", ...pathspec], dir, { allowFail: true });
  for (const changed of tracked.stdout.split("\0").filter(Boolean)) {
    await git(["checkout", "-q", "HEAD", "--", `:(literal)${changed}`], dir, { allowFail: true });
  }
  await git(["clean", opts.includeIgnored ? "-fdxq" : "-fdq", "--", ...pathspec], dir, { allowFail: true });
}

export async function worktreeAdd(repo: string, commitish: string, dir: string): Promise<void> {
  await git(["worktree", "add", "--detach", "-q", dir, commitish], repo);
}

export async function worktreeRemove(repo: string, dir: string): Promise<void> {
  await git(["worktree", "remove", "--force", dir], repo, { allowFail: true });
  await rm(dir, { recursive: true, force: true });
  await git(["worktree", "prune"], repo, { allowFail: true });
}

export async function gitLog(dir: string, limit = 50): Promise<{ hash: string; author: string; subject: string }[]> {
  const r = await git(["log", `-n${limit}`, "--format=%H%x1f%an%x1f%s"], dir, { allowFail: true });
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, author, subject] = line.split("\x1f");
      return { hash, author, subject };
    });
}
