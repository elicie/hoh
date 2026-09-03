/**
 * Canonical UTF-8 byte ceilings for role inputs. Each ceiling is inclusive:
 * exact views and indexes are bounded per disclosure, the candidate-diff limit
 * covers its complete inline block, and the role-prompt limit covers combined
 * system and user prompts. Existing modules re-export these names for callers.
 */
export const CONTEXT_POLICY = Object.freeze({
  maxInlineContextBytes: 8 * 1024,
  maxContextIndexBytes: 4 * 1024,
  maxInlineCandidateDiffBytes: 32 * 1024,
  maxRolePromptBytes: 96 * 1024,
});

export const MAX_INLINE_CONTEXT_BYTES = CONTEXT_POLICY.maxInlineContextBytes;
export const MAX_CONTEXT_INDEX_BYTES = CONTEXT_POLICY.maxContextIndexBytes;
export const MAX_INLINE_CANDIDATE_DIFF_BYTES = CONTEXT_POLICY.maxInlineCandidateDiffBytes;
export const MAX_ROLE_PROMPT_BYTES = CONTEXT_POLICY.maxRolePromptBytes;
