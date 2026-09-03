# 1945 STRIKE — Product Requirements

## Product

A single-file browser vertical-scrolling shooter (`game/index.html`, HTML5 canvas 480×720, no build step, no external assets or network requests) in the style of the arcade classic *1945*. It must run from `file://` and from any static web server, on desktop (keyboard + mouse) and on mobile (touch), in the latest Chrome. The workspace's existing `game/index.html` is the starting artifact; keep it a single self-contained HTML file.

## Player-observable acceptance criteria

1. **Flow.** Title screen → play → (pause) → game over → restart, and after the final stage an **ALL CLEAR / ending screen** with the final score, then back to the title. Restart always resets score, lives, bombs, power, and stage to their initial values.
2. **Controls.** Keyboard: arrows/WASD move, Z or Space fires (hold = autofire), X or Shift bombs, P/Esc pauses, M mutes. Touch: drag moves, autofire while touching, on-screen bomb button. Losing window focus pauses the game. Controls are shown on the title screen.
3. **Stages.** Exactly **3 stages**, each ending with a boss. Each stage has a distinct visual theme (background/palette) and a visible `STAGE n` intro and `STAGE CLEAR` transition. Difficulty increases per stage (enemy speed, fire rate, wave density).
4. **Enemies.** At least **5 enemy types** with distinct movement and firing patterns (e.g., diving fighter, strafing fighter, turret-like heavy, zigzag, formation squadron). Waves are scripted or procedurally varied so consecutive waves are not identical.
5. **Bosses.** Each boss has an HP bar, a `WARNING` intro, and at least **2 attack phases** whose bullet patterns visibly differ. The stage-3 boss is harder than the stage-1 boss (more HP, more patterns). Defeating a boss awards a large score bonus and triggers the stage transition.
6. **Weapons and power-ups.** Player weapon has at least **3 power levels** with visibly wider/denser shots. Drops from enemies: power-up, speed-up, bomb, and a score medal. Bombs (max 5 carried) clear all enemy bullets on screen, damage all enemies, and show a full-screen effect.
7. **Lives and scoring.** 3 starting lives, max 9. Extra lives at score thresholds with a `1UP` popup. Score, hi-score (persisted in `localStorage`, shown on title and game over), and a `NEW RECORD` marker on game over. Killing a full formation without misses gives a visible bonus.
8. **HUD.** Always visible during play: score, hi-score, lives, bombs, current stage, weapon power level, and boss HP bar when a boss is present. The HUD must not overlap the play area in a way that hides enemy bullets.
9. **Audio.** Procedural (Web Audio) sound effects for shooting, hits, explosions, pickups, bomb, extend, and boss warning; looping music that changes tempo or key per stage; M toggles mute and the mute state is visible in the HUD.
10. **Feel.** Screen shake on bombs and big explosions, hit flashes, explosion particles, brief invulnerability with blinking after respawn.
11. **Performance and reliability.** Stable 60 fps on a mid-range laptop in Chrome (measured by the playtest tool: ≥ 55 fps average during a 10 s play sample). No `console.error`, no uncaught exceptions, no memory growth across a full 3-stage run (object pools or array cleanup). The canvas scales to any window size while keeping the 2:3 aspect ratio.
12. **QA hook (required for testability).** When the page is opened with `#debug`, `window.__dbg` exposes read-only getters `state` (`title|play|over|clear`), `paused`, `stage`, `score`, `lives`, `bombs`, `power`, `boss` (boolean), `bossHp` (0..1 or null), `enemyCount`, `shots`, `fps` (rolling average), and the methods `skipToBoss()`, `killBoss()`, `setGod(on)`, `setStage(n)`. These exist only under `#debug` and never affect normal play.

## Out of scope

Multiplayer, online leaderboards, external asset files, frameworks or build tooling, gamepad support.

## Verification tools (public, for the Developer and the QA Tester)

The repository provides `tools/` (not part of the game artifact):

- `node tools/syntax-check.mjs game/index.html` — compiles every inline script; fails on syntax errors.
- `node tools/playtest.mjs --file game/index.html [options]` — drives the game in headless Chrome and prints a JSON summary (runtime versions, blocked network requests, page errors, console errors, fps, `__dbg` samples). Options: `--seconds N`, `--min-fps N`, `--start` (press Space at 0.5 s), `--hold KeyZ` / `--hold ArrowLeft@1:1.5` (hold a key for the run or for a window), `--press KeyX@2` (timed press), `--skip-to-boss@T`, `--call "setStage(3)@T"` (a named `__dbg` method with JSON arguments), `--shot out.png` (final screenshot), `--shots DIR --every S` (periodic screenshots), `--expect key=value` (assert on the final `__dbg` snapshot, repeatable), `--expect-not-state title`, `--fail-on-errors`. Non-local URL schemes are blocked and fail the run.
- Screenshots are PNG files the Tester can open with the `read` tool.

Evidence must come from these executions (JSON summaries, screenshots, console output), from the source, or from `localStorage` inspection, not from reading code alone.
