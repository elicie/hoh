#!/usr/bin/env node
/**
 * Headless-Chrome playtest driver for 1945 STRIKE.
 *
 *   node tools/playtest.mjs --file game/index.html --start --hold KeyZ --seconds 8 --shot play.png --fail-on-errors
 *
 * Screenshot paths are confined to HOH_EVIDENCE_DIR when it is set.
 * Prints a JSON summary to stdout. Exit code 1 when an --expect fails or
 * (with --fail-on-errors) the page raised errors.
 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";

/**
 * Resolve puppeteer-core from this tools/ directory, or from the main
 * workspace's tools/ when running inside an isolated candidate worktree
 * (the HoH runtime exports HOH_WORKSPACE; node_modules is not committed).
 */
async function loadPuppeteer() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dirs = [here, process.env.HOH_WORKSPACE ? path.join(process.env.HOH_WORKSPACE, "tools") : null].filter(Boolean);
  const errors = [];
  for (const dir of dirs) {
    try {
      const entry = createRequire(path.join(dir, "package.json")).resolve("puppeteer-core");
      return (await import(pathToFileURL(entry).href)).default;
    } catch (err) {
      errors.push(`${dir}: ${err?.message ?? err}`);
    }
  }
  throw new Error(`puppeteer-core not found (run \`npm install\` in tools/ of the main workspace):\n  ${errors.join("\n  ")}`);
}
const puppeteer = await loadPuppeteer();

function parseArgs(argv) {
  const o = { file: "game/index.html", seconds: 5, holds: [], presses: [], calls: [], expects: [], shots: null, every: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} requires a value`);
      return value;
    };
    if (a === "--file") o.file = next();
    else if (a === "--seconds") o.seconds = Number(next());
    else if (a === "--min-fps") o.minFps = Number(next());
    else if (a === "--start") o.start = true;
    else if (a === "--hold") o.holds.push(next());
    else if (a === "--press") o.presses.push(next());
    else if (a === "--call") o.calls.push(next());
    else if (a.startsWith("--skip-to-boss")) o.calls.push(`skipToBoss()@${a.includes("@") ? a.split("@")[1] : 1}`);
    else if (a === "--shot") o.shot = next();
    else if (a === "--shots") o.shots = next();
    else if (a === "--every") o.every = Number(next());
    else if (a === "--expect") o.expects.push(next());
    else if (a === "--expect-not-state") o.expectNotState = next();
    else if (a === "--fail-on-errors") o.failOnErrors = true;
    else if (a === "--width") o.width = Number(next());
    else if (a === "--height") o.height = Number(next());
    else if (a === "--help" || a === "-h") {
      console.log("see PRD.md 'Verification tools'");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  for (const [name, value] of [["seconds", o.seconds], ["min-fps", o.minFps], ["every", o.every], ["width", o.width], ["height", o.height]]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`--${name} must be a positive finite number`);
  }
  return o;
}

/** "KeyZ" | "KeyZ@1" | "KeyZ@1:2.5"  -> { key, at, dur } */
function timed(spec, defaultAt = 0) {
  const [key, rest] = spec.split("@");
  if (rest === undefined) return { key, at: defaultAt, dur: null };
  const [at, dur] = rest.split(":");
  const parsed = { key, at: Number(at), dur: dur === undefined ? null : Number(dur) };
  if (!Number.isFinite(parsed.at) || parsed.at < 0 || (parsed.dur !== null && (!Number.isFinite(parsed.dur) || parsed.dur < 0))) {
    throw new Error(`invalid timed event: ${spec}`);
  }
  return parsed;
}

/** `setStage(3)@1` -> a named __dbg method, JSON arguments, and event time. */
function debugCall(spec) {
  const match = /^([A-Za-z_$][\w$]*)\(([\s\S]*)\)(?:@([^@]+))?$/.exec(spec);
  if (!match) throw new Error(`invalid --call (expected method(JSON args)@time): ${spec}`);
  let args;
  try {
    args = match[2].trim() ? JSON.parse(`[${match[2]}]`) : [];
  } catch (err) {
    throw new Error(`invalid JSON arguments in --call ${spec}: ${err?.message ?? err}`);
  }
  const at = Number(match[3] ?? 1);
  if (!Number.isFinite(at) || at < 0) throw new Error(`invalid call event time: ${spec}`);
  return { method: match[1], args, at };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidenceDir = process.env.HOH_EVIDENCE_DIR ? path.resolve(process.env.HOH_EVIDENCE_DIR) : null;

function outputPath(value) {
  if (!evidenceDir) return path.resolve(value);
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(evidenceDir, value);
  if (resolved !== evidenceDir && !resolved.startsWith(`${evidenceDir}${path.sep}`)) {
    throw new Error(`screenshot path escapes HOH_EVIDENCE_DIR: ${value}`);
  }
  return resolved;
}

function summaryPath(value) {
  return evidenceDir ? path.relative(evidenceDir, value).split(path.sep).join("/") : value;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  o.calls = o.calls.map(debugCall);
  if (o.shot) o.shot = outputPath(o.shot);
  if (o.shots) o.shots = outputPath(o.shots);
  const url = `${pathToFileURL(path.resolve(o.file)).href}#debug`;
  const browserArgs = ["--disable-gpu", "--mute-audio", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"];
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: browserArgs,
  });
  const summary = {
    url,
    seconds: o.seconds,
    nodeVersion: process.version,
    browserVersion: await browser.version(),
    pageErrors: [],
    consoleErrors: [],
    consoleWarnings: [],
    blockedNetworkRequests: [],
    samples: [],
    final: null,
    fps: null,
    screenshots: [],
  };
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: o.width ?? 480, height: o.height ?? 720, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      let allowed = false;
      try {
        allowed = new Set(["file:", "data:", "blob:", "about:"]).has(new URL(request.url()).protocol);
      } catch {}
      if (allowed) {
        void request.continue().catch((err) => summary.pageErrors.push(`request continue failed: ${err?.message ?? err}`));
        return;
      }
      summary.blockedNetworkRequests.push({ url: request.url(), method: request.method(), resourceType: request.resourceType() });
      void request.abort("blockedbyclient").catch((err) => summary.pageErrors.push(`request abort failed: ${err?.message ?? err}`));
    });
    page.on("pageerror", (e) => summary.pageErrors.push(String(e?.message ?? e)));
    page.on("console", (m) => {
      if (m.type() === "error") summary.consoleErrors.push(m.text());
      else if (m.type() === "warning") summary.consoleWarnings.push(m.text());
    });
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(() => {
      window.__hohFrames = 0;
      const tick = () => {
        window.__hohFrames++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const dbg = () =>
      page.evaluate(() => {
        const d = window.__dbg;
        if (!d) return null;
        const out = {};
        for (const k of ["state", "paused", "stage", "score", "lives", "bombs", "power", "boss", "bossHp", "enemyCount", "shots", "fps"]) {
          try {
            const v = d[k];
            if (v !== undefined) out[k] = v;
          } catch {}
        }
        return out;
      });

    const events = [];
    if (o.start) events.push({ at: 0.5, run: () => page.keyboard.press("Space") });
    for (const h of o.holds.map((s) => timed(s, 0))) {
      events.push({ at: h.at, run: () => page.keyboard.down(h.key) });
      if (h.dur !== null) events.push({ at: h.at + h.dur, run: () => page.keyboard.up(h.key) });
    }
    for (const p of o.presses.map((s) => timed(s, 0))) events.push({ at: p.at, run: () => page.keyboard.press(p.key) });
    for (const call of o.calls) {
      events.push({
        at: call.at,
        run: () =>
          page.evaluate(({ method, args }) => {
            const d = window.__dbg;
            if (!d) return null;
            if (!Object.prototype.hasOwnProperty.call(d, method) || typeof d[method] !== "function") throw new Error(`unknown __dbg method: ${method}`);
            return Reflect.apply(d[method], d, args);
          }, call),
      });
    }
    events.sort((a, b) => a.at - b.at);
    if (o.shots) await mkdir(o.shots, { recursive: true });

    const t0 = Date.now();
    const frames0 = await page.evaluate(() => window.__hohFrames);
    let nextSample = 0;
    let nextShot = 0;
    let ei = 0;
    while (true) {
      const t = (Date.now() - t0) / 1000;
      while (ei < events.length && events[ei].at <= t) {
        try {
          await events[ei].run();
        } catch (err) {
          summary.pageErrors.push(`event ${JSON.stringify(events[ei].at)}: ${err?.message ?? err}`);
        }
        ei++;
      }
      if (t >= nextSample) {
        summary.samples.push({ t: Number(t.toFixed(2)), ...(await dbg()) });
        nextSample += 0.5;
      }
      if (o.shots && t >= nextShot) {
        const file = path.join(o.shots, `t${String(Math.round(t * 10)).padStart(4, "0")}.png`);
        await page.screenshot({ path: file });
        summary.screenshots.push(summaryPath(file));
        nextShot += o.every;
      }
      if (t >= o.seconds) break;
      await sleep(50);
    }
    const frames1 = await page.evaluate(() => window.__hohFrames);
    summary.fps = Number(((frames1 - frames0) / o.seconds).toFixed(1));
    summary.final = await dbg();
    if (o.shot) {
      await mkdir(path.dirname(path.resolve(o.shot)), { recursive: true });
      await page.screenshot({ path: o.shot });
      summary.screenshots.push(summaryPath(o.shot));
    }
  } finally {
    await browser.close();
  }

  const failures = [];
  if (summary.blockedNetworkRequests.length) failures.push(`blocked ${summary.blockedNetworkRequests.length} non-local network request(s)`);
  if (o.minFps !== undefined && !(summary.fps >= o.minFps)) failures.push(`expected average fps >= ${o.minFps}, got ${JSON.stringify(summary.fps)}`);
  for (const e of o.expects) {
    const [k, v] = e.split("=");
    const actual = summary.final?.[k];
    if (String(actual) !== String(v)) failures.push(`expected ${k}=${v}, got ${JSON.stringify(actual)}`);
  }
  if (o.expectNotState && summary.final?.state === o.expectNotState) failures.push(`state is still ${o.expectNotState}`);
  if (o.failOnErrors && (summary.pageErrors.length || summary.consoleErrors.length)) failures.push(`${summary.pageErrors.length} page error(s), ${summary.consoleErrors.length} console error(s)`);
  summary.failures = failures;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`playtest: ${err?.stack ?? err}`);
  process.exit(2);
});
