import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEMO_SPEC = `# Demo product

A tiny text "game" used to exercise the HoH loop.

Requirements:
1. main.txt names the entry scene.
2. player_control.txt describes left/right input handling.
3. result_state.txt describes the visible completion screen.
`;

export const DEMO_CLAIMS = [
  { id: "main_entry", criterion: "main.txt names the entry scene.", requires: ["check"] },
  { id: "player_control", criterion: "player_control.txt describes left/right input handling.", requires: ["check"] },
  { id: "result_state", criterion: "result_state.txt describes the visible completion screen.", requires: ["check"] },
];

export async function makeWorkspace(): Promise<{ ws: string; spec: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hoh-test-"));
  const ws = path.join(root, "ws");
  const spec = path.join(root, "PRD.md");
  await writeFile(spec, DEMO_SPEC);
  await mkdir(path.join(ws, ".hoh"), { recursive: true });
  await writeFile(
    path.join(ws, ".hoh", "claims.json"),
    `${JSON.stringify({ schema_version: 1, spec_sha256: createHash("sha256").update(DEMO_SPEC).digest("hex"), claims: DEMO_CLAIMS }, null, 2)}\n`,
  );
  return { ws, spec, cleanup: () => rm(root, { recursive: true, force: true }) };
}
