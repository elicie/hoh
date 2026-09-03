/** Resolve and fingerprint the exact pi extensions, skills, and extension tools allowed per role. */
import { createHash } from "node:crypto";
import { globSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { HarnessResourceManifest, ResourceManifestEntry, Role, RoleResourceManifest } from "../types.js";
import { ROLES } from "../types.js";
import type { HohConfig } from "./config.js";
import { canonicalSha256 } from "./protocol.js";

interface TreeEntry {
  path: string;
  kind: "file" | "directory";
  sha256?: string;
}

export async function buildPiResourceManifest(config: HohConfig, workspace: string): Promise<HarnessResourceManifest> {
  const sharedExtensions = config.pi.extensions ?? [];
  const sharedSkills = config.pi.skills ?? [];
  const hasPaths = ROLES.some((role) => {
    const roleConfig = config.pi.roles?.[role];
    return sharedExtensions.length > 0 || sharedSkills.length > 0 || Boolean(roleConfig?.extensions?.length || roleConfig?.skills?.length);
  });
  const workspaceRoot = hasPaths ? await realpath(workspace) : path.resolve(workspace);
  const roles = Object.fromEntries(
    await Promise.all(
      ROLES.map(async (role) => {
        const roleConfig = config.pi.roles?.[role];
        const extensions = await resolveEntries(effectivePaths(sharedExtensions, roleConfig?.extensions), workspaceRoot, role, "extension");
        const skills = await resolveEntries(effectivePaths(sharedSkills, roleConfig?.skills), workspaceRoot, role, "skill");
        const payload = {
          extensions,
          skills,
          extension_tools: [...(roleConfig?.extension_tools ?? [])],
        };
        const manifest: RoleResourceManifest = { ...payload, manifest_sha256: canonicalSha256(payload) };
        return [role, manifest] as const;
      }),
    ),
  ) as Record<Role, RoleResourceManifest>;
  const payload = { schema_version: 1 as const, roles };
  return { ...payload, manifest_sha256: canonicalSha256(payload) };
}

/** Re-hash a role's allowlisted resources immediately before its pi session is created. */
export async function assertPiResourceManifestCurrent(manifest: HarnessResourceManifest, role: Role): Promise<void> {
  const recorded = manifest.roles[role];
  if (!recorded) throw new Error(`pi resource manifest has no ${role} contract`);
  const extensions = await refreshEntries(recorded.extensions, role, "extension");
  const skills = await refreshEntries(recorded.skills, role, "skill");
  const payload = { extensions, skills, extension_tools: [...recorded.extension_tools] };
  const actual = canonicalSha256(payload);
  if (actual !== recorded.manifest_sha256) {
    throw new Error(
      `pi resources changed for ${role} after run start (${recorded.manifest_sha256.slice(0, 12)} -> ${actual.slice(0, 12)}); restart with a fresh resource manifest`,
    );
  }
}

function effectivePaths(shared: readonly string[], role: readonly string[] | undefined): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const configured of [...shared, ...(role ?? [])]) {
    const normalized = path.normalize(configured);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(configured);
  }
  return paths;
}

async function resolveEntries(
  configuredPaths: readonly string[],
  workspaceRoot: string,
  role: Role,
  resourceKind: "extension" | "skill",
): Promise<ResourceManifestEntry[]> {
  const entries: ResourceManifestEntry[] = [];
  const resolvedPaths = new Set<string>();
  for (const configuredPath of configuredPaths) {
    const candidate = path.resolve(workspaceRoot, configuredPath);
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(candidate);
    } catch (error: any) {
      throw new Error(`pi ${role} ${resourceKind} ${JSON.stringify(configuredPath)} cannot be resolved: ${error?.message ?? error}`);
    }
    assertWithinWorkspace(resolvedPath, workspaceRoot, role, resourceKind, configuredPath);
    if (resolvedPaths.has(resolvedPath)) {
      throw new Error(`pi ${role} ${resourceKind} paths resolve to the same resource: ${JSON.stringify(configuredPath)} -> ${resolvedPath}`);
    }
    resolvedPaths.add(resolvedPath);
    entries.push(await fingerprintResource(configuredPath, resolvedPath, role, resourceKind));
  }
  return entries;
}

async function refreshEntries(
  entries: readonly ResourceManifestEntry[],
  role: Role,
  resourceKind: "extension" | "skill",
): Promise<ResourceManifestEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      let currentRealpath: string;
      try {
        currentRealpath = await realpath(entry.resolved_path);
      } catch (error: any) {
        throw new Error(`pi ${role} ${resourceKind} ${JSON.stringify(entry.configured_path)} is no longer available: ${error?.message ?? error}`);
      }
      if (currentRealpath !== entry.resolved_path) {
        throw new Error(
          `pi ${role} ${resourceKind} ${JSON.stringify(entry.configured_path)} changed identity (${entry.resolved_path} -> ${currentRealpath})`,
        );
      }
      return fingerprintResource(entry.configured_path, currentRealpath, role, resourceKind);
    }),
  );
}

function assertWithinWorkspace(
  resolvedPath: string,
  workspaceRoot: string,
  role: Role,
  resourceKind: "extension" | "skill",
  configuredPath: string,
): void {
  const relative = path.relative(workspaceRoot, resolvedPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `pi ${role} ${resourceKind} ${JSON.stringify(configuredPath)} resolves outside the workspace (${resolvedPath})`,
    );
  }
  if (relative === ".hoh" || relative.startsWith(`.hoh${path.sep}`)) {
    throw new Error(
      `pi ${role} ${resourceKind} ${JSON.stringify(configuredPath)} resolves inside runtime-owned .hoh (${resolvedPath})`,
    );
  }
}

async function fingerprintResource(
  configuredPath: string,
  resolvedPath: string,
  role: Role,
  resourceKind: "extension" | "skill",
): Promise<ResourceManifestEntry> {
  const stat = await lstat(resolvedPath);
  if (stat.isFile()) {
    return { configured_path: configuredPath, resolved_path: resolvedPath, kind: "file", sha256: sha256(await readFile(resolvedPath)) };
  }
  if (stat.isDirectory()) {
    const tree: TreeEntry[] = [];
    await collectDirectoryTree(resolvedPath, resolvedPath, "", tree, role, resourceKind, configuredPath);
    return { configured_path: configuredPath, resolved_path: resolvedPath, kind: "directory", sha256: canonicalSha256(tree) };
  }
  throw new Error(`pi ${role} ${resourceKind} ${JSON.stringify(configuredPath)} must resolve to a regular file or directory`);
}

async function collectDirectoryTree(
  directory: string,
  resourceRoot: string,
  relativeDirectory: string,
  output: TreeEntry[],
  role: Role,
  resourceKind: "extension" | "skill",
  configuredPath: string,
): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const child of children) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
    const absolutePath = path.join(directory, child.name);
    if (child.isSymbolicLink()) {
      throw new Error(
        `pi ${role} ${resourceKind} ${JSON.stringify(configuredPath)} contains unsupported symbolic link ${JSON.stringify(relativePath)}`,
      );
    }
    if (child.isDirectory()) {
      output.push({ path: relativePath, kind: "directory" });
      await collectDirectoryTree(absolutePath, resourceRoot, relativePath, output, role, resourceKind, configuredPath);
      continue;
    }
    if (child.isFile()) {
      const bytes = await readFile(absolutePath);
      output.push({ path: relativePath, kind: "file", sha256: sha256(bytes) });
      if (resourceKind === "extension" && child.name === "package.json") {
        assertExtensionManifestContained(bytes, absolutePath, resourceRoot, role, configuredPath);
      }
      continue;
    }
    throw new Error(
      `pi ${role} ${resourceKind} ${JSON.stringify(configuredPath)} contains unsupported entry ${JSON.stringify(relativePath)}`,
    );
  }
}

function assertExtensionManifestContained(
  bytes: Uint8Array,
  manifestPath: string,
  resourceRoot: string,
  role: Role,
  configuredPath: string,
): void {
  let value: any;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return; // pi ignores an invalid package manifest and falls back to directory discovery.
  }
  const entries = value?.pi?.extensions;
  if (!Array.isArray(entries) || !entries.every((entry: unknown) => typeof entry === "string")) return;
  for (const entry of entries as string[]) {
    if (/^[!+-]/.test(entry)) continue; // selection filters do not resolve entrypoints.
    const manifestRoot = path.dirname(manifestPath);
    const hasGlob = entry.includes("*") || entry.includes("?");
    if (hasGlob && /[{}[\]()\\]/.test(entry)) {
      throw new Error(
        `pi ${role} extension ${JSON.stringify(configuredPath)} package manifest uses unsupported traversal-capable glob syntax: ${JSON.stringify(entry)}`,
      );
    }
    const resolvedPattern = path.resolve(manifestRoot, entry);
    const relative = path.relative(resourceRoot, resolvedPattern);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(
        `pi ${role} extension ${JSON.stringify(configuredPath)} package manifest declares an entrypoint outside the configured directory: ${JSON.stringify(entry)}`,
      );
    }
    if (!hasGlob) continue;
    let matches: string[];
    try {
      matches = globSync(entry, { cwd: manifestRoot });
    } catch (error: any) {
      throw new Error(
        `pi ${role} extension ${JSON.stringify(configuredPath)} package manifest has an invalid entrypoint glob ${JSON.stringify(entry)}: ${error?.message ?? error}`,
      );
    }
    for (const match of matches) {
      const matchedRealpath = realpathSync(path.resolve(manifestRoot, match));
      const matchedRelative = path.relative(resourceRoot, matchedRealpath);
      if (matchedRelative === ".." || matchedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(matchedRelative)) {
        throw new Error(
          `pi ${role} extension ${JSON.stringify(configuredPath)} package manifest glob resolves outside the configured directory: ${JSON.stringify(entry)} -> ${matchedRealpath}`,
        );
      }
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
