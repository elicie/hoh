import { createHash } from "node:crypto";

export const REDACTION_MARKER = "[REDACTED]";

/**
 * Explicit values shorter than eight Unicode code points are too likely to be
 * ordinary prose or source-code fragments to replace safely without context.
 */
export const MIN_EXPLICIT_SECRET_CODE_POINTS = 8;

export type RedactionRuleId =
  | "authorization-header"
  | "json-credential-field"
  | "url-userinfo"
  | "url-query-credential"
  | "explicit-secret-value";

export interface RedactionRuleCount {
  readonly id: RedactionRuleId;
  readonly count: number;
}

export interface StorageRedactionResult {
  readonly stored_text: string;
  readonly original_sha256: string;
  readonly stored_sha256: string;
  readonly redacted: boolean;
  readonly replacement_count: number;
  readonly rules: readonly RedactionRuleCount[];
}

export type NamedSecretValues = Readonly<Record<string, string | null | undefined>>;

const RULE_IDS = [
  "authorization-header",
  "json-credential-field",
  "url-userinfo",
  "url-query-credential",
  "explicit-secret-value",
] as const satisfies readonly RedactionRuleId[];

// Exact, case-insensitive placeholder values remain untouched in free text;
// syntax-aware rules still redact them when they occupy a credential field.
const COMMON_EXPLICIT_VALUES = new Set([
  "api_key",
  "apikey",
  "access_token",
  "changeme",
  "client_secret",
  "default",
  "example",
  "example.com",
  "false",
  "localhost",
  "none",
  "null",
  "password",
  "placeholder",
  "refresh_token",
  "secret",
  "testing",
  "true",
  "undefined",
  "unknown",
  "username",
]);

const AUTHORIZATION_HEADER = /^([\t ]*authorization[\t ]*:[\t ]*(?:bearer|basic)[\t ]+)([^\r\n]*?)([\t ]*)$/gim;
const JSON_CREDENTIAL_FIELD = /("(?:api_key|access_token|refresh_token|client_secret|password)"\s*:\s*")((?:\\[\s\S]|[^"\\])*)(")/gi;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]+)@/i;
const URL_QUERY_CREDENTIAL = /(^|&)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)=)([^&]*)/gi;
const TRAILING_PROSE_PUNCTUATION = /[)\]},.;]+$/;

/**
 * Produce a redacted storage copy of a complete in-memory string.
 *
 * The returned original hash covers the UTF-8 encoding of the exact JavaScript
 * string supplied to this function. Explicit secret names and per-secret
 * hashes are intentionally not retained. Syntax-aware rules run before
 * explicit values and all replacement counts are reported under a fixed,
 * non-secret rule vocabulary. A zero count means only that these narrow rules
 * made no replacement; it is not proof that arbitrary input contains no secret.
 */
export function redactStorageText(content: string, explicitSecrets: NamedSecretValues = {}): StorageRedactionResult {
  const counts = new Map<RedactionRuleId, number>(RULE_IDS.map((id) => [id, 0]));
  let stored = content;

  stored = stored.replace(AUTHORIZATION_HEADER, (match, prefix: string, value: string, trailing: string) => {
    if (!shouldReplaceContextualValue(value)) return match;
    increment(counts, "authorization-header");
    return `${prefix}${REDACTION_MARKER}${trailing}`;
  });

  stored = stored.replace(JSON_CREDENTIAL_FIELD, (match, prefix: string, value: string, quote: string) => {
    if (!shouldReplaceContextualValue(value)) return match;
    increment(counts, "json-credential-field");
    return `${prefix}${REDACTION_MARKER}${quote}`;
  });

  stored = stored.replace(URL, (url) => redactUrl(url, counts));

  for (const secret of normalizedExplicitSecrets(explicitSecrets)) {
    const replaced = replaceLiteral(stored, secret, REDACTION_MARKER);
    stored = replaced.text;
    if (replaced.count > 0) increment(counts, "explicit-secret-value", replaced.count);
  }

  const rules = Object.freeze(
    RULE_IDS.map((id) => Object.freeze({ id, count: counts.get(id) ?? 0 })),
  );
  const replacementCount = rules.reduce((total, rule) => total + rule.count, 0);

  return Object.freeze({
    stored_text: stored,
    original_sha256: sha256(content),
    stored_sha256: sha256(stored),
    redacted: replacementCount > 0,
    replacement_count: replacementCount,
    rules,
  });
}

function redactUrl(url: string, counts: Map<RedactionRuleId, number>): string {
  let suffix = url.match(TRAILING_PROSE_PUNCTUATION)?.[0] ?? "";
  let core = suffix ? url.slice(0, -suffix.length) : url;
  const markerClosingCharacter = REDACTION_MARKER.at(-1) ?? "";
  if (
    markerClosingCharacter &&
    suffix.startsWith(markerClosingCharacter) &&
    core.endsWith(REDACTION_MARKER.slice(0, -markerClosingCharacter.length))
  ) {
    core += markerClosingCharacter;
    suffix = suffix.slice(markerClosingCharacter.length);
  }
  let redacted = core.replace(URL_USERINFO, (match, scheme: string, userinfo: string) => {
    if (!shouldReplaceContextualValue(userinfo)) return match;
    increment(counts, "url-userinfo");
    return `${scheme}${REDACTION_MARKER}@`;
  });

  const fragmentAt = redacted.indexOf("#");
  const beforeFragment = fragmentAt >= 0 ? redacted.slice(0, fragmentAt) : redacted;
  const fragment = fragmentAt >= 0 ? redacted.slice(fragmentAt) : "";
  const queryAt = beforeFragment.indexOf("?");
  if (queryAt >= 0) {
    const throughQuestionMark = beforeFragment.slice(0, queryAt + 1);
    const query = beforeFragment.slice(queryAt + 1).replace(
      URL_QUERY_CREDENTIAL,
      (match, separator: string, key: string, value: string) => {
        if (!shouldReplaceContextualValue(value)) return match;
        increment(counts, "url-query-credential");
        return `${separator}${key}${REDACTION_MARKER}`;
      },
    );
    redacted = `${throughQuestionMark}${query}${fragment}`;
  }

  return `${redacted}${suffix}`;
}

function shouldReplaceContextualValue(value: string): boolean {
  return value.length > 0 && value !== REDACTION_MARKER;
}

function normalizedExplicitSecrets(explicitSecrets: NamedSecretValues): string[] {
  const values = new Set<string>();

  for (const value of Object.values(explicitSecrets)) {
    if (typeof value !== "string") continue;
    const normalizedForSafety = value.trim().toLowerCase();
    if (Array.from(value).length < MIN_EXPLICIT_SECRET_CODE_POINTS) continue;
    if (!normalizedForSafety || COMMON_EXPLICIT_VALUES.has(normalizedForSafety)) continue;
    if (REDACTION_MARKER.includes(value)) continue;
    values.add(value);
  }

  return [...values].sort((left, right) => {
    const lengthDifference = Array.from(right).length - Array.from(left).length;
    if (lengthDifference !== 0) return lengthDifference;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function replaceLiteral(input: string, needle: string, replacement: string): { text: string; count: number } {
  let cursor = 0;
  let index = input.indexOf(needle, cursor);
  if (index < 0) return { text: input, count: 0 };

  const pieces: string[] = [];
  let count = 0;
  while (index >= 0) {
    pieces.push(input.slice(cursor, index), replacement);
    cursor = index + needle.length;
    count += 1;
    index = input.indexOf(needle, cursor);
  }
  pieces.push(input.slice(cursor));
  return { text: pieces.join(""), count };
}

function increment(counts: Map<RedactionRuleId, number>, id: RedactionRuleId, amount = 1): void {
  counts.set(id, (counts.get(id) ?? 0) + amount);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
