/** Capture provenance at the trusted process/tool boundary, never from QA prose. */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { EvidenceExecution } from "../types.js";
import { evidencePriority, MAX_EVIDENCE_FILE_BYTES as MAX_FILE_BYTES, MAX_EVIDENCE_LOOP_BYTES as MAX_TOTAL_BYTES } from "./evidence-files.js";

export function snapshotEvidenceFiles(directory: string): Map<string, string> {
  const result = new Map<string, string>();
  const candidates: string[] = [];
  let bytes = 0;
  const visit = (relative: string): void => {
    const absolute = path.join(directory, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(path.join(relative, name));
    } else if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
      candidates.push(relative.split(path.sep).join("/"));
    }
  };
  try { visit(""); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  candidates.sort((a, b) => evidencePriority(a) - evidencePriority(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const relative of candidates) {
    try {
      const content = readFileSync(path.join(directory, relative));
      if (content.length > MAX_FILE_BYTES || bytes + content.length > MAX_TOTAL_BYTES) continue;
      bytes += content.length;
      result.set(relative, createHash("sha256").update(content).digest("hex"));
    } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }
  return result;
}

export class ExecutionEvidenceCapture {
  readonly executions: EvidenceExecution[] = [];
  private pending = new Map<string, { command: string; before: Map<string, string> }>();

  constructor(private readonly directory: string | undefined) {}

  start(id: string, command: string): void {
    if (this.directory) this.pending.set(id, { command, before: snapshotEvidenceFiles(this.directory) });
  }

  end(id: string, exitCode: number): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (!pending || !this.directory) return;
    const files = [...snapshotEvidenceFiles(this.directory)]
      .filter(([file, hash]) => pending.before.get(file) !== hash)
      .map(([file, hash]) => ({ path: file, sha256: hash }));
    this.executions.push({ id, command: pending.command, exit_code: exitCode, files });
  }
}
