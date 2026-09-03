import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEMO_SPEC = `# Demo product

A tiny text "game" used to exercise the HoH loop.

Requirements:
1. main.txt names the entry scene.
2. player_control.txt describes left/right input handling.
3. result_state.txt describes the visible completion screen.
`;

export async function makeWorkspace(): Promise<{ ws: string; spec: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hoh-test-"));
  const ws = path.join(root, "ws");
  const spec = path.join(root, "PRD.md");
  await writeFile(spec, DEMO_SPEC);
  return { ws, spec, cleanup: () => rm(root, { recursive: true, force: true }) };
}
