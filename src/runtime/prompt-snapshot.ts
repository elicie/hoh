import { createHash } from "node:crypto";
import type { Role, RolePromptSnapshot } from "../types.js";

export function promptSha256(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/** Hash an unambiguous JSON tuple of the exact system and user prompt strings. */
export function combinedPromptInputSha256(systemPrompt: string, userPrompt: string): string {
  return promptSha256(JSON.stringify([systemPrompt, userPrompt]));
}

export function buildPromptSnapshot(input: {
  role: Role;
  loopIndex: number;
  finalAttempt: number;
  systemPrompt: string;
  userPrompt: string;
  createdAt?: string;
}): RolePromptSnapshot {
  return {
    schema_version: 1,
    role: input.role,
    loop_index: input.loopIndex,
    final_attempt: input.finalAttempt,
    system_prompt: input.systemPrompt,
    user_prompt: input.userPrompt,
    system_prompt_sha256: promptSha256(input.systemPrompt),
    user_prompt_sha256: promptSha256(input.userPrompt),
    combined_input_sha256: combinedPromptInputSha256(input.systemPrompt, input.userPrompt),
    created_at: input.createdAt ?? new Date().toISOString(),
  };
}
