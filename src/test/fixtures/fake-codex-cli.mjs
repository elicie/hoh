#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli fixture-1.0.0\n");
  process.exit(0);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const schemaPath = valueAfter("--output-schema");
const outputPath = valueAfter("--output-last-message");
let final = "fixture final response";
if (schemaPath) {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  final = JSON.stringify(sample(schema));
}
if (outputPath) await writeFile(outputPath, final);
if (process.env.FAKE_CODEX_RECORD) {
  await writeFile(process.env.FAKE_CODEX_RECORD, JSON.stringify({ args, prompt, final }));
}
if (process.env.FAKE_CODEX_WAIT_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CODEX_WAIT_MS)));
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fixture-thread" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: final } })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 } })}\n`);

function sample(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(schema, "const")) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return sample(schema.anyOf[0]);
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return sample(schema.oneOf[0]);
  if (schema.type === "object" || schema.properties) {
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, sample(value)]));
  }
  if (schema.type === "array") {
    const count = Math.max(0, schema.minItems ?? 0);
    return Array.from({ length: count }, () => sample(schema.items));
  }
  if (schema.type === "boolean") return true;
  if (schema.type === "integer" || schema.type === "number") return Math.max(1, schema.exclusiveMinimum ?? schema.minimum ?? 1);
  if (schema.pattern?.includes("a-z0-9")) return "fixture_claim";
  return "fixture-value";
}
