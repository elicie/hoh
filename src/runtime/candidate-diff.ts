/** A deterministic, artifact-scoped base-vs-candidate diff for the QA prompt. */
import { Buffer } from "node:buffer";
import path from "node:path";
import { git } from "./git.js";

/** Maximum UTF-8 bytes injected inline for the complete candidate diff block. */
export const MAX_INLINE_CANDIDATE_DIFF_BYTES = 32 * 1024;

export interface CandidateDiffBundle {
  baseCommit: string;
  candidateCommit: string;
  changedFileCount: number;
  mode: "full" | "headers";
  /** Stat, changed-file list, and full patch or bounded headers. */
  inline: string;
  /** Exact artifact-scoped command the read-only Tester can run for detail. */
  inspectCommand: string;
}

/**
 * One literal path boundary shared by every diff view. Disabling rename
 * detection prevents a move across that boundary from disclosing the path on
 * the other side.
 */
export function artifactDiffPathspec(artifactDir: string): string[] {
  const normalized = path.normalize(artifactDir).replaceAll(path.sep, "/").replace(/\/+$/, "") || ".";
  return normalized === "." ? [".", ":(top,exclude,literal).hoh"] : [`:(top,literal)${normalized}`];
}

export async function buildCandidateDiff(
  dir: string,
  input: { baseCommit: string; candidateCommit: string; artifactDir: string },
): Promise<CandidateDiffBundle> {
  const pathspec = artifactDiffPathspec(input.artifactDir);
  const range = `${input.baseCommit}..${input.candidateCommit}`;
  const fixed = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", range, "--", ...pathspec];
  const [statResult, namesResult, patchResult] = await Promise.all([
    git(["diff", "--stat", ...fixed], dir),
    git(["diff", "--name-only", "-z", ...fixed], dir),
    git(["diff", "--patch", "--unified=3", ...fixed], dir),
  ]);

  const changedPaths = namesResult.stdout.split("\0").filter(Boolean);
  const stat = statResult.stdout.trimEnd() || "(no changes)";
  const names = changedPaths.length ? changedPaths.map((name) => JSON.stringify(name)).join("\n") : "(none)";
  const patch = patchResult.stdout.trimEnd() || "(no diff)";
  const full = renderSections(stat, names, patch, "Patch");
  const inspectCommand = renderInspectCommand(range, pathspec);

  if (utf8Bytes(full) <= MAX_INLINE_CANDIDATE_DIFF_BYTES) {
    return {
      baseCommit: input.baseCommit,
      candidateCommit: input.candidateCommit,
      changedFileCount: changedPaths.length,
      mode: "full",
      inline: full,
      inspectCommand,
    };
  }

  const notice = `Full patch omitted: the inline diff exceeded ${MAX_INLINE_CANDIDATE_DIFF_BYTES} UTF-8 bytes.`;
  // Keep each metadata class represented even when one class alone is huge.
  const statBudget = Math.floor(MAX_INLINE_CANDIDATE_DIFF_BYTES * 0.2);
  const namesBudget = Math.floor(MAX_INLINE_CANDIDATE_DIFF_BYTES * 0.2);
  const headersBudget = Math.floor(MAX_INLINE_CANDIDATE_DIFF_BYTES * 0.5);
  const boundedStat = boundWholeLines(stat.split("\n"), statBudget, "... additional stat lines omitted ...");
  const boundedNames = boundWholeLines(names.split("\n"), namesBudget, "... additional changed paths omitted ...");
  const headers = diffHeaderLines(patchResult.stdout);
  const boundedHeaders = boundWholeLines(
    headers.length ? headers : ["(no textual hunk headers)"],
    headersBudget,
    "... additional hunk headers omitted ...",
  );
  let inline = `${notice}\n\n${renderSections(boundedStat, boundedNames, boundedHeaders, "Patch metadata and hunk headers")}`;
  if (utf8Bytes(inline) > MAX_INLINE_CANDIDATE_DIFF_BYTES) {
    inline = boundWholeLines(inline.split("\n"), MAX_INLINE_CANDIDATE_DIFF_BYTES, "... candidate diff metadata omitted ...");
  }

  return {
    baseCommit: input.baseCommit,
    candidateCommit: input.candidateCommit,
    changedFileCount: changedPaths.length,
    mode: "headers",
    inline,
    inspectCommand,
  };
}

function renderSections(stat: string, names: string, patch: string, patchTitle: string): string {
  return [`### Diff stat`, stat, "", `### Changed files`, names, "", `### ${patchTitle}`, patch].join("\n");
}

function diffHeaderLines(patch: string): string[] {
  const headers: string[] = [];
  let inFileHeader = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      headers.push(line);
      inFileHeader = true;
      continue;
    }
    if (line.startsWith("@@")) {
      headers.push(line);
      inFileHeader = false;
      continue;
    }
    if (
      inFileHeader &&
      /^(?:new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |index |--- |\+\+\+ |Binary files )/.test(
        line,
      )
    ) {
      headers.push(line);
    }
  }
  return headers;
}

function boundWholeLines(lines: string[], maxBytes: number, marker: string): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const bytes = utf8Bytes(line) + (kept.length ? 1 : 0);
    if (used + bytes > maxBytes) break;
    kept.push(line);
    used += bytes;
  }
  if (kept.length < lines.length) {
    const markerBytes = utf8Bytes(marker) + (kept.length ? 1 : 0);
    while (kept.length && used + markerBytes > maxBytes) {
      const removed = kept.pop()!;
      used -= utf8Bytes(removed) + (kept.length ? 1 : 0);
    }
    if (utf8Bytes(marker) <= maxBytes) kept.push(marker);
  }
  return kept.join("\n");
}

function renderInspectCommand(range: string, pathspec: string[]): string {
  return [
    "git",
    "--no-pager",
    "diff",
    "--patch",
    "--unified=3",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    shellQuote(range),
    "--",
    ...pathspec.map(shellQuote),
  ].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
