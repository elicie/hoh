import type { PiModelsJson } from "../runtime/providers.js";
/**
 * Harness adapter contract.
 *
 * HoH invokes the same fixed harness three times per loop with role-specific
 * prompts, tool allowlists, working directories, and structured-output tools.
 * The adapter is the only place that knows how to drive a particular coding
 * agent (pi, a CLI, a mock).
 */
import type { TSchema } from "typebox";
import type { EvidenceExecution, HarnessResourceManifest, Role, UsageTotals } from "../types.js";

export type BuiltinTool = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

/** Planner: may inspect the artifact, may not execute or modify it. */
export const READ_ONLY_TOOLS: readonly BuiltinTool[] = ["read", "grep", "find", "ls"];
/** Tester: may build, run, and inspect the frozen copy, may not edit it. */
export const INSPECT_TOOLS: readonly BuiltinTool[] = ["read", "bash", "grep", "find", "ls"];
/** Developer: single writer. */
export const CODING_TOOLS: readonly BuiltinTool[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** Every pi SDK built-in name extensions must not override, including the Windows-only shell tool. */
export const PI_BUILTIN_TOOL_NAMES: readonly string[] = [...CODING_TOOLS, "powershell"];

export interface StructuredTool {
  name: string;
  description: string;
  parameters: TSchema;
}

export interface RoleInvocation {
  role: Role;
  loopIndex: number;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  tools: readonly BuiltinTool[];
  structuredTools: StructuredTool[];
  /** Trusted adapter events; the runtime keeps these bytes out of role-visible files until the role exits. */
  onTranscript?: (chunk: string) => void;
  timeoutMs?: number;
  /** Cooperative cancellation owned by the outer runtime lifecycle. */
  signal?: AbortSignal;
  /** harness-specific model pattern for this role (from config); undefined = harness default */
  model?: string;
  /** Runtime-owned QA evidence destination, distinct from the frozen candidate. */
  evidenceDir?: string;
}

export interface RoleResult {
  finalText: string;
  /** model actually used, for the run record */
  model?: string;
  /** tool name -> every payload submitted through that structured tool */
  submissions: Record<string, unknown[]>;
  usage: UsageTotals;
  turns: number;
  /** Trusted adapter events from actual executions; never copy these from model submissions. */
  executions?: EvidenceExecution[];
  /** Same-session transient retries reported by the adapter. Detailed events remain in the transcript. */
  retryCount?: number;
  /** Successful automatic context compactions performed inside this role session. */
  compactionCount?: number;
  /** Sum of context-token estimates immediately before successful compactions. */
  compactionTokensBefore?: number;
  /** Most recent post-compaction context-token estimate, when reported. */
  compactionEstimatedTokensAfter?: number;
}

export interface HarnessRolePolicy {
  workspace: "active-read-only" | "active-writer" | "isolated-read-only";
  /** Adapter-native capability names recorded in the immutable protocol receipt. */
  builtinTools: readonly string[];
}

export interface Harness {
  readonly name: string;
  /** Adapter/package version recorded in the immutable protocol receipt. */
  readonly version?: string;
  /** An adapter must not claim its requested model was independently reported. */
  readonly modelReporting?: "session" | "unavailable";
  /** Exact role resources resolved before run start, when the adapter supports them. */
  readonly resourceManifest?: HarnessResourceManifest;
  /** Prepared provider configuration; persisted only after resume verification. */
  readonly providerModels?: PiModelsJson;
  /** Resolve a configured pattern to the concrete model/reasoning identity used by this adapter. */
  resolveModel?(pattern?: string): Promise<string | null>;
  /** Override the default pi-style tool receipt when an adapter enforces rights through another mechanism. */
  rolePolicy?(role: Role): HarnessRolePolicy;
  /** Idempotent adapter output-contract adaptation, applied before prompt limits and snapshots. */
  preparePrompts?(inv: RoleInvocation): { systemPrompt: string; prompt: string };
  invoke(inv: RoleInvocation): Promise<RoleResult>;
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}
