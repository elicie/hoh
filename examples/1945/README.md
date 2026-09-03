# 1945 STRIKE example

This reusable input kit was extracted from a three-loop 1945 STRIKE HoH run.
It targets the HoH revision containing this directory and intentionally omits
the generated game, `.hoh/` state, credentials, and execution output.

## Contents

- `PRD.md`: the original product requirements and QA contract.
- `hoh.config.json`: a credential-safe `extended` configuration template with
  separate model slots for development and QA. This model split is a local
  extension, not the paper protocol's source of QA independence.
- `.gitignore`: excludes local credentials, installed dependencies, and loose
  screenshots. The PRD requires the game itself to remain one HTML file.
- `tools/`: the syntax checker and headless-Chrome playtest driver used by the
  run. `package-lock.json` pins their dependency graph.

## Use

Prerequisites are Node.js 22.19 or newer, a local Chrome installation, a built
checkout of the matching HoH revision, and a starting `game/index.html`.

1. Copy this directory's contents into the workspace containing the starting
   game file.
2. Replace `DEVELOPER_MODEL_ID` and `INDEPENDENT_TESTER_MODEL_ID` in
   `hoh.config.json` with model IDs exposed by your OpenAI-compatible gateway.
   Adjust their context, output, and reasoning metadata to match that gateway.
   QA remains operationally independent through its separate invocation,
   frozen candidate, and read-only contract even if both slots use one model.
3. Export `GATEWAY_BASE_URL` and `GATEWAY_API_KEY`. Do not put credentials in
   the committed config. If Chrome is not at `/usr/bin/google-chrome`, export
   `CHROME_PATH` too.
4. Validate and run HoH from its own checkout:

   ```bash
   node /path/to/hoh/dist/cli.js config --workspace . --config hoh.config.json
   node /path/to/hoh/dist/cli.js run --workspace . --spec PRD.md --config hoh.config.json
   ```

Pass the root `hoh.config.json` only when starting the run. On resume, omit
`--config` so HoH reuses the protected `.hoh/config.json` recorded for that
run instead of re-reading a root file the Developer could have changed.

`artifact_dir: "game"` scopes the deterministic-check working directory and
candidate hash; it is not a filesystem write boundary. Before checks run,
`worktree_setup` verifies SHA-256 for both tools and their package manifests,
then installs the locked dependency inside the isolated candidate worktree.
This prevents a candidate or ignored main-workspace dependency from silently
replacing the verifier. During a HoH run, every `--shot` and `--shots`
destination must stay beneath `HOH_EVIDENCE_DIR`, and the JSON summary records
those images relative to that directory. Outside HoH, paths resolve from the
current directory.

The four configured checks are smoke gates, not proof of every PRD criterion.
The FPS gate measures the page's main-thread `requestAnimationFrame`
responsiveness during scripted play, not individual game-render calls. The
Tester still needs independent interactions and retained screenshots alongside
runtime JSON; game-provided `window.__dbg` values alone do not prove
player-visible behavior.

Chrome is required but is not installed by this kit. The playtest tool opens
the local HTML file with `#debug`; the game must implement the read-only
`window.__dbg` contract in `PRD.md`.
Chrome's sandbox remains enabled. The tool blocks and reports requests whose
URL scheme is not `file:`, `data:`, `blob:`, or `about:`.
