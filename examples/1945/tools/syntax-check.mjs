#!/usr/bin/env node
/**
 * Compile every inline <script> of an HTML file. Fails on syntax errors.
 *   node tools/syntax-check.mjs game/index.html
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const file = process.argv[2] ?? "game/index.html";
const html = readFileSync(file, "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
if (scripts.length === 0) {
  console.error(`${file}: no inline <script> found`);
  process.exit(1);
}
let failed = 0;
scripts.forEach((src, i) => {
  try {
    new vm.Script(src, { filename: `${file}#script${i + 1}` });
    console.log(`script ${i + 1}: ok (${src.length} chars)`);
  } catch (err) {
    failed++;
    console.error(`script ${i + 1}: ${err.message}`);
  }
});
if (!/<canvas\b/i.test(html)) {
  console.error(`${file}: no <canvas> element`);
  failed++;
}
process.exit(failed ? 1 : 0);
