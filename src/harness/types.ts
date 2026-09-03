/**
 * Harness adapter contract.
 *
 * HoH invokes the same fixed harness three times per loop with role-specific
 * prompts, tool allowlists, working directories, and structured-output tools.
 * The adapter is the only place that knows how to drive a particular coding
 * agent (pi, a CLI, a mock).
 */
import type { TSchema } from "typebox";
import type { Role, UsageTotals } from "../types.js";

export type BuiltinTool = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

/** Planner: may inspect the artifact, may not execute or modify it. */
export const READ_ONLY_TOOLS: readonly BuiltinTool[] = ["read", "grep", "find", "ls"];
/** Tester: may build, run, and inspect the frozen copy, may not edit it. */
export const INSPECT_TOOLS: readonly BuiltinTool[] = ["read", "bash", "grep", "find", "ls"];
/** Developer: single writer. */
export const CODING_TOOLS: readonly BuiltinTool[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

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
  /** harness-specific model pattern for this role (from config); undefined = harness default */
  model?: string;
}

export interface RoleResult {
  finalText: string;
  /** model actually used, for the run record */
  model?: string;
  /** tool name -> every payload submitted through that structured tool */
  submissions: Record<string, unknown[]>;
  usage: UsageTotals;
  turns: number;
}

export interface Harness {
  readonly name: string;
  /** Adapter/package version recorded in the immutable protocol receipt. */
  readonly version?: string;
  /** Resolve a configured pattern to the concrete model/reasoning identity used by this adapter. */
  resolveModel?(pattern?: string): Promise<string | null>;
  invoke(inv: RoleInvocation): Promise<RoleResult>;
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}
