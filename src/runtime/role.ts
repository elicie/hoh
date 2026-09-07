/** Shared role invocation, accounting, transcripts, and failed-role restoration. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Harness, RoleInvocation, RoleResult } from "../harness/types.js";
import { emptyUsage } from "../harness/types.js";
import type { EvidenceExecution, RoleUsage, RunConfig } from "../types.js";
import { BudgetTracker } from "./budget.js";
import { git, headCommit, pathsChanged, restorePaths } from "./git.js";
import { assertRolePromptWithinLimit } from "./prompts.js";
import { redactStorageText, type ExplicitSecretValues } from "./redaction.js";
import { RunPaths, pad } from "./state.js";

interface RoleContext {
  ws: string;
  paths: RunPaths;
  run: RunConfig;
  harness: Harness;
  budget: BudgetTracker;
  storageSecrets: ExplicitSecretValues;
  log: (message: string) => void;
  signal?: AbortSignal;
}

interface InvokeOutcome {
  result: RoleResult;
  attempts: number;
  usage: RoleUsage;
  /** Exact user prompt delivered on the final attempt, including any retry notice. */
  finalUserPrompt: string;
  finalSystemPrompt: string;
  transcript: TranscriptCapture | null;
}

interface RuntimeRoleInvocation extends RoleInvocation {
  /** Runtime destination; never forwarded to the role harness. */
  transcriptPath?: string;
}

interface TranscriptCapture {
  finalPath: string;
  content: string;
}

export async function invokeRole(ctx: RoleContext, inv: RuntimeRoleInvocation, requiredTool?: string): Promise<InvokeOutcome> {
  const baselineHead = await headCommit(ctx.ws);
  let budgetAttempt: string | null = null;
  let transcript: TranscriptCapture | null = null;
  let started = 0;
  let completedHarnessResults = 0;
  const total: RoleUsage = { ...emptyUsage(), turns: 0, duration_ms: 0 };
  const executions: EvidenceExecution[] = [];
  let retryCount = 0;
  let compactionCount = 0;
  let compactionTokensBefore = 0;
  let compactionEstimatedTokensAfter: number | undefined;
  let attempts = 0;
  let result: RoleResult = { finalText: "", submissions: {}, usage: emptyUsage(), turns: 0 };
  let finalUserPrompt = inv.prompt;
  let finalSystemPrompt = inv.systemPrompt;
  const maxAttempts = requiredTool ? 2 : 1;
  const { transcriptPath: _transcriptPath, onTranscript: upstreamTranscript, ...harnessInvocation } = inv;
  const signal = inv.signal ?? ctx.signal;
  const onTranscript = (chunk: string) => {
    if (transcript) transcript.content += chunk;
    upstreamTranscript?.(chunk);
  };
  try {
    budgetAttempt = await ctx.budget.beginRole(inv.loopIndex, inv.role);
    started = Date.now();
    transcript = await beginTranscriptCapture(inv.transcriptPath);
    while (attempts < maxAttempts) {
      signal?.throwIfAborted();
      attempts += 1;
      const prompt =
        attempts === 1
          ? inv.prompt
          : `${inv.prompt}\n\n## Runtime notice\n\nYour previous attempt ended without calling \`${requiredTool}\`. The runtime only accepts output delivered through that tool. Redo the work as needed and call \`${requiredTool}\` exactly once before finishing.`;
      const prepared = ctx.harness.preparePrompts?.({ ...harnessInvocation, prompt }) ?? { systemPrompt: inv.systemPrompt, prompt };
      assertRolePromptWithinLimit(inv.role, prepared.systemPrompt, prepared.prompt);
      finalUserPrompt = prepared.prompt;
      finalSystemPrompt = prepared.systemPrompt;
      result = await ctx.harness.invoke({ ...harnessInvocation, ...prepared, onTranscript, signal });
      for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const) total[k] += result.usage[k] ?? 0;
      total.turns += result.turns;
      retryCount += result.retryCount ?? 0;
      compactionCount += result.compactionCount ?? 0;
      compactionTokensBefore += result.compactionTokensBefore ?? 0;
      if (result.compactionEstimatedTokensAfter !== undefined) {
        compactionEstimatedTokensAfter = result.compactionEstimatedTokensAfter;
      }
      if (result.model) total.model = result.model;
      executions.push(...(result.executions ?? []).map((execution) => ({
        ...execution,
        command: redactStorageText(execution.command, ctx.storageSecrets).stored_text,
        id: `${inv.loopIndex}:${inv.role}:${attempts}:${execution.id}`,
      })));
      completedHarnessResults += 1;
      signal?.throwIfAborted();
      if (ctx.run.protocol_receipt?.mode === "paper") {
        const expected = ctx.run.protocol_receipt.models[inv.role];
        if (!expected || result.model !== expected) {
          throw new Error(
            `paper protocol model mismatch for ${inv.role}: expected ${expected ?? "(none)"}, harness reported ${result.model ?? "(none)"}`,
          );
        }
      }
      if (!requiredTool || (result.submissions[requiredTool]?.length ?? 0) > 0 || parseJsonBlock(result.finalText)) break;
      ctx.log(`[loop ${pad(inv.loopIndex)}] ${inv.role}: no ${requiredTool} call; retrying (${attempts}/${maxAttempts})`);
    }
    total.duration_ms = Date.now() - started;
    if (retryCount > 0) total.retry_count = retryCount;
    if (compactionCount > 0) {
      total.compaction_count = compactionCount;
      total.compaction_tokens_before = compactionTokensBefore;
      if (compactionEstimatedTokensAfter !== undefined) total.compaction_estimated_tokens_after = compactionEstimatedTokensAfter;
    }
    await ctx.budget.completeRole(budgetAttempt, total);
  } catch (error) {
    if (budgetAttempt) {
      try {
        if (completedHarnessResults > 0) {
          total.duration_ms = Math.max(0, Date.now() - started);
          if (retryCount > 0) total.retry_count = retryCount;
          if (compactionCount > 0) {
            total.compaction_count = compactionCount;
            total.compaction_tokens_before = compactionTokensBefore;
            if (compactionEstimatedTokensAfter !== undefined) total.compaction_estimated_tokens_after = compactionEstimatedTokensAfter;
          }
        }
        await ctx.budget.failRole(budgetAttempt, completedHarnessResults > 0 ? total : undefined);
      } catch (budgetWriteError: any) {
        ctx.log(
          `[loop ${pad(inv.loopIndex)}] runtime: WARNING could not close budget attempt ${budgetAttempt}: ${budgetWriteError?.message ?? budgetWriteError}`,
        );
      }
    }
    if (transcript) {
      // Restore against the runtime's baseline even when the failed role committed its writes.
      if (baselineHead && await headCommit(ctx.ws) !== baselineHead) {
        await git(["reset", "--mixed", "-q", baselineHead], ctx.ws);
      }
      await restoreFailedRoleRuntimeWrites(ctx.ws, ctx.paths, inv.loopIndex, inv.role, transcript, ctx.storageSecrets);
      await ctx.budget.persist();
    }
    const failure = error instanceof Error ? error : new Error(String(error));
    throw failure;
  }
  return { result: { ...result, executions }, attempts, usage: total, finalUserPrompt, finalSystemPrompt, transcript };
}

export function abortMessage(error: unknown, signal: AbortSignal | undefined): string {
  const reason = signal?.reason ?? error;
  return reason instanceof Error ? reason.message : String(reason ?? "operation aborted");
}

async function beginTranscriptCapture(finalPath: string | undefined): Promise<TranscriptCapture | null> {
  if (!finalPath) return null;
  let content = "";
  try {
    content = await readFile(finalPath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { finalPath, content };
}

export async function installCapturedTranscript(capture: TranscriptCapture | null, storageSecrets: ExplicitSecretValues): Promise<void> {
  if (!capture) return;
  await mkdir(path.dirname(capture.finalPath), { recursive: true });
  await rm(capture.finalPath, { force: true });
  if (capture.content) await writeFile(capture.finalPath, redactStorageText(capture.content, storageSecrets).stored_text);
}

async function restoreFailedRoleRuntimeWrites(
  workspace: string,
  paths: RunPaths,
  loopIndex: number,
  role: string | undefined,
  capture: TranscriptCapture,
  storageSecrets: ExplicitSecretValues,
): Promise<void> {
  if (role === "planner" || role === "tester") {
    const workspaceChanges = await pathsChanged(workspace, [".", ":(exclude).hoh"]);
    if (workspaceChanges.length) await restorePaths(workspace, [".", ":(exclude).hoh"]);
  }
  const evidenceRel = paths.rel(paths.evidenceDir(loopIndex)).replaceAll(path.sep, "/");
  const immutableCheckRel = `${evidenceRel}/checks/`;
  const unauthorized = (await pathsChanged(workspace, [".hoh"], { includeIgnored: true })).filter((changed) => {
    const rel = changed.replaceAll(path.sep, "/");
    return !(role === "tester" && rel.startsWith(`${evidenceRel}/`) && !rel.startsWith(immutableCheckRel));
  });
  if (unauthorized.length) {
    await restorePaths(
      workspace,
      unauthorized.map((changed) => `:(literal)${changed}`),
      { includeIgnored: true },
    );
  }
  await installCapturedTranscript(capture, storageSecrets);
}

/** Fallback for harnesses without tool support: a fenced ```json block in the final text. */
export function parseJsonBlock<T>(text: string): T | null {
  const m = /```json\s*([\s\S]*?)```/i.exec(text ?? "");
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as T;
  } catch {
    return null;
  }
}
