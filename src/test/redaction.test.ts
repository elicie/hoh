import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MIN_EXPLICIT_SECRET_CODE_POINTS,
  REDACTION_MARKER,
  configuredProviderSecretValues,
  redactStorageText,
  type RedactionRuleId,
} from "../runtime/redaction.js";

function countFor(result: ReturnType<typeof redactStorageText>, id: RedactionRuleId): number {
  return result.rules.find((rule) => rule.id === id)?.count ?? -1;
}

test("explicit secret values are removed without retaining names or per-secret fingerprints", () => {
  const value = "super-private-value-12345";
  const secrets = Object.freeze({ SUPER_PRIVATE_ENV_NAME: value });
  const content = `first=${value}\nsecond=${value}\nbenign=retained`;

  const result = redactStorageText(content, secrets);
  const metadata = JSON.stringify({ ...result, stored_text: undefined });

  assert.equal(result.stored_text, `first=${REDACTION_MARKER}\nsecond=${REDACTION_MARKER}\nbenign=retained`);
  assert.equal(result.replacement_count, 2);
  assert.equal(countFor(result, "explicit-secret-value"), 2);
  assert.equal(result.redacted, true);
  assert.ok(!result.stored_text.includes(value));
  assert.ok(!metadata.includes(value));
  assert.ok(!metadata.includes("SUPER_PRIVATE_ENV_NAME"));
  assert.deepEqual(secrets, { SUPER_PRIVATE_ENV_NAME: value });
});

test("overlapping explicit values are deduplicated and replaced longest-first", () => {
  const short = "token-1234";
  const long = `${short}-suffix`;
  const content = `${long}|${short}|${long}`;
  const result = redactStorageText(content, {
    short,
    long,
    duplicate: long,
  });
  const reordered = redactStorageText(content, { duplicate: long, long, short });

  assert.equal(result.stored_text, `${REDACTION_MARKER}|${REDACTION_MARKER}|${REDACTION_MARKER}`);
  assert.equal(result.replacement_count, 3);
  assert.equal(countFor(result, "explicit-secret-value"), 3);
  assert.deepEqual(reordered, result);
});

test("unsafe explicit values are ignored while contextual credential syntax is redacted", () => {
  assert.equal(MIN_EXPLICIT_SECRET_CODE_POINTS, 8);
  const unsafe = Object.freeze({ empty: "", short: "abc1234", common: "password", commonLong: "undefined" });
  const content = [
    "ordinary test password undefined words stay",
    "Authorization: Bearer bearer.token.value",
    "authorization : Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==   ",
    '{"api_key":"a","access_token":"access-value","refresh_token":"refresh-value","client_secret":"client-value","password":"p","note":"password"}',
    "https://alice:s3cr3t@example.test/path?api_key=query-key&other=keep&password=query-pass#frag",
  ].join("\n");

  const result = redactStorageText(content, unsafe);

  assert.match(result.stored_text, /^ordinary test password undefined words stay$/m);
  assert.match(result.stored_text, /^Authorization: Bearer \[REDACTED\]$/m);
  assert.match(result.stored_text, /^authorization : Basic \[REDACTED\]   $/m);
  assert.ok(result.stored_text.includes(`{"api_key":"${REDACTION_MARKER}","access_token":"${REDACTION_MARKER}","refresh_token":"${REDACTION_MARKER}","client_secret":"${REDACTION_MARKER}","password":"${REDACTION_MARKER}","note":"password"}`));
  assert.ok(result.stored_text.includes(`https://${REDACTION_MARKER}@example.test/path?api_key=${REDACTION_MARKER}&other=keep&password=${REDACTION_MARKER}#frag`));
  assert.equal(countFor(result, "authorization-header"), 2);
  assert.equal(countFor(result, "json-credential-field"), 5);
  assert.equal(countFor(result, "url-userinfo"), 1);
  assert.equal(countFor(result, "url-query-credential"), 2);
  assert.equal(countFor(result, "explicit-secret-value"), 0);
  assert.equal(result.replacement_count, 10);
});

test("hashes cover exact UTF-8 input and the stored redacted bytes", () => {
  const secret = "초장기비밀값-🙂-123456";
  const original = `앞🙂\r\n${secret}\n뒤`;
  const result = redactStorageText(original, { unicode: secret });

  assert.equal(result.original_sha256, createHash("sha256").update(Buffer.from(original, "utf8")).digest("hex"));
  assert.equal(result.stored_sha256, createHash("sha256").update(Buffer.from(result.stored_text, "utf8")).digest("hex"));
  assert.equal(result.stored_text, `앞🙂\r\n${REDACTION_MARKER}\n뒤`);
});

test("URL redaction preserves prose punctuation and ignores path or fragment lookalikes", () => {
  const content = [
    "(https://example.test/path?api_key=query-key).",
    "https://example.test/path&password=benign",
    "https://example.test/#?access_token=benign",
  ].join(" ");
  const result = redactStorageText(content);

  assert.equal(
    result.stored_text,
    `(https://example.test/path?api_key=${REDACTION_MARKER}). https://example.test/path&password=benign https://example.test/#?access_token=benign`,
  );
  assert.equal(countFor(result, "url-query-credential"), 1);
  assert.equal(result.replacement_count, 1);
});

test("redacting an already-redacted string is idempotent", () => {
  const secret = "a-secret-long-enough";
  const first = redactStorageText(
    `Authorization: Bearer auth-value\n{"password":"p"}\nhttps://u:p@example.test/?access_token=q\n${secret}`,
    { explicit: secret },
  );
  const second = redactStorageText(first.stored_text, { explicit: secret, markerFragment: "REDACTED" });

  assert.equal(second.stored_text, first.stored_text);
  assert.equal(second.original_sha256, first.stored_sha256);
  assert.equal(second.stored_sha256, first.stored_sha256);
  assert.equal(second.redacted, false);
  assert.equal(second.replacement_count, 0);
  assert.deepEqual(second.rules.map((rule) => rule.count), [0, 0, 0, 0, 0]);
});

test("explicit secrets are removed from JSON-escaped and URL-encoded storage forms", () => {
  const secret = 'line one\n"line/two"';
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);
  const urlEncoded = encodeURIComponent(secret);
  const result = redactStorageText(`raw=${secret}\njson=${jsonEscaped}\nurl=${urlEncoded}`, [secret]);

  assert.equal(result.stored_text, `raw=${REDACTION_MARKER}\njson=${REDACTION_MARKER}\nurl=${REDACTION_MARKER}`);
  assert.equal(countFor(result, "explicit-secret-value"), 3);
});

test("configured provider secrets resolve referenced values without scanning env or running commands", () => {
  const configured = "configured-value-12345";
  const header = "header-value-12345";
  const unrelated = "unrelated-value-12345";
  const values = configuredProviderSecretValues(
    {
      providers: {
        local: {
          base_url: "http://localhost:11434/v1",
          api_key: "$CONFIGURED_KEY",
          headers: {
            "X-Access-Token": "Bearer ${HEADER_TOKEN}",
            "X-Trace": "public-trace-value",
            "X-Command-Secret": "!credential-helper",
          },
          models: ["test"],
        },
      },
    },
    { CONFIGURED_KEY: configured, HEADER_TOKEN: header, UNRELATED_KEY: unrelated },
  );

  assert.deepEqual(values, [configured, header]);
  const redacted = redactStorageText(`${configured}|${header}|${unrelated}|public-trace-value`, values);
  assert.equal(redacted.stored_text, `${REDACTION_MARKER}|${REDACTION_MARKER}|${unrelated}|public-trace-value`);
});
