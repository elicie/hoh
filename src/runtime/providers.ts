/**
 * OpenAI-compatible (and Anthropic-compatible) model providers declared in
 * hoh.config.json, materialized into a pi `models.json` so that the pi
 * runtime can talk to them. Supports model discovery through `GET /models`.
 */
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { HohConfig, ProviderConfig, ProviderModelConfig } from "./config.js";
import { writeJson } from "./state.js";

export const DEFAULT_DISCOVER_EXCLUDE = ["image", "video", "embed", "tts", "whisper", "audio", "moderation", "rerank", "transcri", "speech"];

/** Expand `$NAME` / `${NAME}` from the environment. Throws when a referenced variable is unset. */
export function expandEnv(value: string, what: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a: string | undefined, b: string | undefined) => {
    const name = a ?? b!;
    const v = process.env[name];
    if (v === undefined || v === "") throw new Error(`${what} references $${name}, which is not set in the environment (export it or put it in .env)`);
    return v;
  });
}

/** Resolve an api_key value the way pi does: `$ENV`, `!command`, or literal. */
export function resolveSecret(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("!")) return execSync(value.slice(1), { encoding: "utf8" }).trim();
  if (value.startsWith("$")) return expandEnv(value, what);
  return value;
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "0.0.0.0" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

export interface DiscoveredModel {
  id: string;
  owned_by?: string;
}

export async function discoverModels(name: string, p: ProviderConfig, opts: { fetchImpl?: typeof fetch } = {}): Promise<DiscoveredModel[]> {
  const f = opts.fetchImpl ?? fetch;
  const baseUrl = expandEnv(p.base_url, `providers.${name}.base_url`).replace(/\/+$/, "");
  const key = resolveSecret(p.api_key, `providers.${name}.api_key`);
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  for (const [k, v] of Object.entries(p.headers ?? {})) headers[k] = resolveSecret(v, `providers.${name}.headers.${k}`) ?? "";
  let res: Response;
  try {
    res = await f(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (err: any) {
    throw new Error(`providers.${name}: model discovery failed for ${baseUrl}/models: ${err?.message ?? err}`);
  }
  if (!res.ok) throw new Error(`providers.${name}: model discovery failed: ${baseUrl}/models returned HTTP ${res.status}`);
  const body: any = await res.json();
  const data: any[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const excludes = (p.discover?.exclude ?? DEFAULT_DISCOVER_EXCLUDE).map((s) => new RegExp(s, "i"));
  const includes = (p.discover?.include ?? []).map((s) => new RegExp(s, "i"));
  const models = data
    .map((m) => ({ id: String(m?.id ?? m?.name ?? ""), owned_by: m?.owned_by ? String(m.owned_by) : undefined }))
    .filter((m) => m.id)
    .filter((m) => (includes.length ? includes.some((r) => r.test(m.id)) : true))
    .filter((m) => !excludes.some((r) => r.test(m.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (models.length === 0) throw new Error(`providers.${name}: model discovery returned no usable models from ${baseUrl}/models`);
  return models;
}

// ---------------------------------------------------------------------------
// pi models.json
// ---------------------------------------------------------------------------

export interface PiModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, number>;
  compat?: Record<string, unknown>;
}

export interface PiProviderEntry {
  baseUrl: string;
  api: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: PiModelEntry[];
}

export interface PiModelsJson {
  providers: Record<string, PiProviderEntry>;
  /** hoh bookkeeping: discovered ids per provider (not read by pi) */
  hoh?: { discovered: Record<string, string[]> };
}

function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function camelKeys<T extends object>(o: T | undefined): Record<string, unknown> | undefined {
  if (!o) return undefined;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v]));
}

export function toPiModel(id: string, p: ProviderConfig, explicit?: Partial<ProviderModelConfig>): PiModelEntry {
  const merged: Partial<ProviderModelConfig> = { ...(p.model_defaults ?? {}), ...(explicit ?? {}), ...(p.model_overrides?.[id] ?? {}) };
  const entry: PiModelEntry = { id };
  if (merged.name) entry.name = merged.name;
  if (merged.api) entry.api = merged.api;
  if (merged.reasoning !== undefined) entry.reasoning = merged.reasoning;
  if (merged.input) entry.input = merged.input;
  if (merged.context_window !== undefined) entry.contextWindow = merged.context_window;
  if (merged.max_tokens !== undefined) entry.maxTokens = merged.max_tokens;
  if (merged.cost) entry.cost = merged.cost;
  if (merged.compat) entry.compat = camelKeys(merged.compat);
  return entry;
}

export interface BuildOptions {
  /** previously generated file, reused when discovery fails */
  previous?: PiModelsJson | null;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

/** Build the pi models.json for every provider declared in the config (discovering models where requested). */
export async function buildPiModelsJson(config: HohConfig, opts: BuildOptions = {}): Promise<PiModelsJson> {
  const out: PiModelsJson = { providers: {}, hoh: { discovered: {} } };
  for (const [name, p] of Object.entries(config.providers)) {
    let models: PiModelEntry[];
    if (p.models === "discover") {
      try {
        const found = await discoverModels(name, p, { fetchImpl: opts.fetchImpl });
        models = found.map((m) => toPiModel(m.id, p));
        out.hoh!.discovered[name] = found.map((m) => m.id);
        opts.log?.(`providers.${name}: discovered ${found.length} model(s)`);
      } catch (err: any) {
        const cached = opts.previous?.providers?.[name]?.models;
        if (cached && cached.length) {
          opts.log?.(`providers.${name}: ${err?.message ?? err}; reusing ${cached.length} previously discovered model(s)`);
          models = cached;
          out.hoh!.discovered[name] = cached.map((m) => m.id);
        } else {
          throw err;
        }
      }
    } else {
      models = p.models.map((m) => (typeof m === "string" ? toPiModel(m, p) : toPiModel(m.id, p, m)));
    }
    const entry: PiProviderEntry = {
      baseUrl: expandEnv(p.base_url, `providers.${name}.base_url`),
      api: p.api ?? "openai-completions",
      models,
    };
    if (p.api_key !== undefined) entry.apiKey = p.api_key; // pi resolves $ENV / !cmd itself at request time
    if (p.headers) entry.headers = p.headers;
    if (p.compat) entry.compat = camelKeys(p.compat);
    out.providers[name] = entry;
  }
  return out;
}

export async function readPiModelsJson(file: string): Promise<PiModelsJson | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as PiModelsJson;
  } catch {
    return null;
  }
}

/** Write the pi models.json for this run. Returns null when the config declares no providers. */
export async function materializePiModels(config: HohConfig, file: string, opts: Omit<BuildOptions, "previous"> = {}): Promise<PiModelsJson | null> {
  if (Object.keys(config.providers).length === 0) return null;
  const previous = await readPiModelsJson(file);
  const built = await buildPiModelsJson(config, { ...opts, previous });
  // Write only on change: the file lives in the run record, and churn would look like a workspace mutation.
  if (JSON.stringify(previous) !== JSON.stringify(built)) await writeJson(file, built);
  return built;
}
