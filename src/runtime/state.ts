/**
 * On-disk layout of a run. Everything lives under `<workspace>/.hoh/` so the
 * git history of the workspace carries the development record, the way the
 * Fusepoint trajectory repository keeps `.gameloop/`.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BudgetLedger, Ledger, Role, RunConfig } from "../types.js";
import { pathMatchesHead } from "./git.js";
import { emptyLedger } from "./ledger.js";

export const HOH_DIR = ".hoh";

export function pad(i: number): string {
  return String(i).padStart(2, "0");
}

/** Parse only the canonical positive loop directory names emitted by RunPaths. */
export function parseLoopDirName(name: string): number | null {
  const match = /^loop-(\d+)$/.exec(name);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index > 0 && name === `loop-${pad(index)}` ? index : null;
}

export class RunPaths {
  readonly root: string;
  constructor(readonly workspace: string) {
    this.root = path.join(workspace, HOH_DIR);
  }
  get runJson() {
    return path.join(this.root, "run.json");
  }
  get spec() {
    return path.join(this.root, "spec.md");
  }
  get config() {
    return path.join(this.root, "config.json");
  }
  /** generated pi models.json for the providers declared in the config */
  get piModels() {
    return path.join(this.root, "pi-models.json");
  }
  /** exact resolved extension/skill/tool allowlist used by the pi adapter */
  get piResources() {
    return path.join(this.root, "pi-resources.json");
  }
  get ledger() {
    return path.join(this.root, "ledger.json");
  }
  /** Canonical role/loop/run resource accounting and exhaustion state. */
  get budget() {
    return path.join(this.root, "budget.json");
  }
  /** Canonical offline-verifiable receipt for the current durable run state. */
  get receipt() {
    return path.join(this.root, "receipt.json");
  }
  get claims() {
    return path.join(this.root, "claims.json");
  }
  get coverage() {
    return path.join(this.root, "coverage.json");
  }
  get claimsTranscript() {
    return path.join(this.root, "claims-transcript.jsonl");
  }
  get readme() {
    return path.join(this.root, "README.md");
  }
  get iterations() {
    return path.join(this.root, "iterations");
  }
  loopDir(i: number) {
    return path.join(this.iterations, `loop-${pad(i)}`);
  }
  plannerJson(i: number) {
    return path.join(this.loopDir(i), "planner.json");
  }
  developmentDocument(i: number) {
    return path.join(this.loopDir(i), "development_document.md");
  }
  developerJson(i: number) {
    return path.join(this.loopDir(i), "developer.json");
  }
  checksJson(i: number) {
    return path.join(this.loopDir(i), "checks.json");
  }
  evidenceJson(i: number) {
    return path.join(this.loopDir(i), "evidence.json");
  }
  evidenceDir(i: number) {
    return path.join(this.loopDir(i), "evidence");
  }
  testerReport(i: number) {
    return path.join(this.loopDir(i), "tester_report.md");
  }
  errorJson(i: number) {
    return path.join(this.loopDir(i), "error.json");
  }
  promptsDir(i: number) {
    return path.join(this.loopDir(i), "prompts");
  }
  promptSnapshot(i: number, role: Role) {
    return path.join(this.promptsDir(i), `${role}.json`);
  }
  transcript(i: number, role: Role) {
    return path.join(this.loopDir(i), "transcripts", `${role}.jsonl`);
  }
  /** workspace-relative form for prompts and records */
  rel(p: string) {
    return path.relative(this.workspace, p);
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text.endsWith("\n") ? text : `${text}\n`);
}

export async function loadRun(paths: RunPaths): Promise<RunConfig | null> {
  return readJson<RunConfig>(paths.runJson);
}

export async function loadLedger(paths: RunPaths): Promise<Ledger> {
  return (await readJson<Ledger>(paths.ledger)) ?? emptyLedger();
}

export async function loadBudgetLedger(paths: RunPaths): Promise<BudgetLedger | null> {
  return readJson<BudgetLedger>(paths.budget);
}

/** Highest loop index that has an evidence bundle (i.e. completed all three roles). */
export async function lastCompletedLoop(paths: RunPaths): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(paths.iterations);
  } catch (error: any) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let last = 0;
  for (const name of entries) {
    const i = parseLoopDirName(name);
    if (i === null) continue;
    if (
      (await pathMatchesHead(paths.workspace, paths.rel(paths.evidenceJson(i)))) &&
      (await readJson(paths.evidenceJson(i))) !== null
    ) {
      last = Math.max(last, i);
    }
  }
  return last;
}
