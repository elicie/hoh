import { createHash } from "node:crypto";
import type { Role, RolePromptSnapshot, StoredPromptFieldMetadata } from "../types.js";
import { redactStorageText, type ExplicitSecretValues, type StorageRedactionResult } from "./redaction.js";

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
  /** Values are filtered by the storage redactor; record labels are never persisted. */
  explicitSecrets?: ExplicitSecretValues;
  createdAt?: string;
}): RolePromptSnapshot {
  const systemStorage = redactStorageText(input.systemPrompt, input.explicitSecrets);
  const userStorage = redactStorageText(input.userPrompt, input.explicitSecrets);

  return {
    schema_version: 2,
    role: input.role,
    loop_index: input.loopIndex,
    final_attempt: input.finalAttempt,
    system_prompt: systemStorage.stored_text,
    user_prompt: userStorage.stored_text,
    system_prompt_sha256: promptSha256(input.systemPrompt),
    user_prompt_sha256: promptSha256(input.userPrompt),
    combined_input_sha256: combinedPromptInputSha256(input.systemPrompt, input.userPrompt),
    system_prompt_storage: storageMetadata(systemStorage),
    user_prompt_storage: storageMetadata(userStorage),
    created_at: input.createdAt ?? new Date().toISOString(),
  };
}

function storageMetadata(redaction: StorageRedactionResult): StoredPromptFieldMetadata {
  return {
    stored_sha256: redaction.stored_sha256,
    redacted: redaction.redacted,
    replacement_count: redaction.replacement_count,
    rules: redaction.rules,
  };
}
