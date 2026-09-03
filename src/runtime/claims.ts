/** Model-assisted initialization of the fixed PRD claim catalog. */
import { appendFile, mkdir } from "node:fs/promises";
import type { Harness } from "../harness/types.js";
import { READ_ONLY_TOOLS } from "../harness/types.js";
import type { ClaimCatalog, CoverageState } from "../types.js";
import { emptyCoverage, loadClaimCatalog, makeClaimCatalog, rebuildCoverage } from "./coverage.js";
import { renderClaimDraftPrompts } from "./prompts.js";
import { redactStorageText, type ExplicitSecretValues } from "./redaction.js";
import { claimsTools, SUBMIT_CLAIMS_TOOL } from "./schemas.js";
import { readJson, type RunPaths, writeJson } from "./state.js";

export interface ClaimGenerationOptions {
  workspace: string;
  specPath: string;
  spec: string;
  harness: Harness;
  paths: RunPaths;
  model?: string;
  /** Concrete model identity required by a paper run's start receipt. */
  expectedModel?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Explicit provider credential values removed from persisted transcripts. */
  storageSecrets?: ExplicitSecretValues;
}

export interface ClaimState {
  catalog: ClaimCatalog;
  coverage: CoverageState;
  created: boolean;
}

export async function generateClaimCatalog(options: ClaimGenerationOptions): Promise<ClaimCatalog> {
  const prompts = await renderClaimDraftPrompts({ cwd: options.workspace, specPath: options.specPath, spec: options.spec });
  let lastProblem = `planner returned no ${SUBMIT_CLAIMS_TOOL} call`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    options.signal?.throwIfAborted();
    const prompt =
      attempt === 1
        ? prompts.user
        : `${prompts.user}\n\n## Runtime notice\n\nYour previous attempt did not produce a valid fixed claim catalog (${lastProblem}). Call \`${SUBMIT_CLAIMS_TOOL}\` exactly once with corrected claims.`;
    let transcript = "";
    const result = await options.harness
      .invoke({
        role: "planner",
        loopIndex: 0,
        cwd: options.workspace,
        systemPrompt: prompts.system,
        prompt,
        tools: READ_ONLY_TOOLS,
        structuredTools: claimsTools,
        onTranscript: (chunk) => {
          transcript += chunk;
        },
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        model: options.model,
      })
      .finally(async () => {
        if (!transcript) return;
        await mkdir(options.paths.root, { recursive: true });
        await appendFile(options.paths.claimsTranscript, redactStorageText(transcript, options.storageSecrets).stored_text);
      });
    options.signal?.throwIfAborted();
    if (options.expectedModel && result.model !== options.expectedModel) {
      throw new Error(
        `paper protocol model mismatch for planner claim initialization: expected ${options.expectedModel}, harness reported ${result.model ?? "(none)"}`,
      );
    }
    const payload = lastSubmission(result.submissions[SUBMIT_CLAIMS_TOOL]) ?? parseJsonBlock(result.finalText);
    try {
      const claims = payload && typeof payload === "object" ? (payload as any).claims : null;
      return makeClaimCatalog(options.spec, claims);
    } catch (error: any) {
      lastProblem = error?.message ?? String(error);
    }
  }
  throw new Error(`claim generation failed after 2 attempts: ${lastProblem}`);
}

export async function ensureClaimState(options: ClaimGenerationOptions): Promise<ClaimState> {
  let catalog = await loadClaimCatalog(options.paths, options.spec);
  let created = false;
  if (!catalog) {
    catalog = await generateClaimCatalog(options);
    options.signal?.throwIfAborted();
    await writeJson(options.paths.claims, catalog);
    created = true;
  }
  options.signal?.throwIfAborted();
  const coverage = await rebuildCoverage(options.paths, catalog);
  options.signal?.throwIfAborted();
  await writeJson(options.paths.coverage, coverage);
  return { catalog, coverage, created };
}

export async function initializeClaimState(options: ClaimGenerationOptions): Promise<ClaimState> {
  if ((await readJson<unknown>(options.paths.claims)) !== null) {
    throw new Error(`${options.paths.claims} already exists; edit it directly or remove it before regenerating`);
  }
  const catalog = await generateClaimCatalog(options);
  options.signal?.throwIfAborted();
  const coverage = emptyCoverage(catalog);
  await writeJson(options.paths.claims, catalog);
  options.signal?.throwIfAborted();
  await writeJson(options.paths.coverage, coverage);
  return { catalog, coverage, created: true };
}

function lastSubmission(list: unknown[] | undefined): unknown | null {
  return list?.length ? list[list.length - 1] : null;
}

function parseJsonBlock(text: string): unknown | null {
  const match = /```json\s*([\s\S]*?)```/i.exec(text ?? "");
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}
