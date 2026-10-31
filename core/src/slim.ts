// wt slim — removes restorable artifacts (dependencies, build cache) in all stopped
// worktrees when disk space runs out. Code, git, env and port are left alone: docker volumes are
// refilled by `wt start` (ensureDeps), host directories by the same `wt start` (ensureHostDeps).
// It also removes orphan volumes: wtdev volumes with neither a worktree nor a base (the worktree was deleted bypassing `wt rm`).
// classifySlim is a pure function over the collected facts; fs/docker only in the collector.

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { rm, readdir } from "node:fs/promises";
import { listWorktrees } from "./worktrees";
import { listProjects } from "./projects";
import { BASE_SLUG } from "./new-worktree";
import { listRunningInstances } from "./run";
import { resolveProjectConfig, resolveProjectsDir, UnlistedProjectError } from "./config";
import { loadPlugin, type InstanceCtx } from "./plugin";
import { containerName } from "./containers";
import { projectDir } from "./paths";
import { DEFAULT_STORAGE_DIR, volumeDir } from "./storage";

export interface SlimFacts {
  running: boolean;
  /** existing host directories from plugin.artifactDirs, with their size. */
  dirs: { path: string; bytes: number }[];
  /** existing docker volumes from plugin.docker().ownedVolumes. */
  volumes: string[];
}

export type SlimReason = "slim" | "running" | "clean";

export interface SlimDecision {
  action: "slim" | "skip";
  reason: SlimReason;
}

export function classifySlim(f: SlimFacts): SlimDecision {
  if (f.running) return { action: "skip", reason: "running" };
  if (!f.dirs.length && !f.volumes.length) return { action: "skip", reason: "clean" };
  return { action: "slim", reason: "slim" };
}

/** wtdev volumes that belong to no existing worktree and no base (it was deleted bypassing `wt rm`). */
export function findOrphanVolumes(all: string[], owned: Set<string>): string[] {
  return all.filter((v) => v.startsWith("wtdev-") && !owned.has(v));
}

export interface SlimItem extends SlimDecision, SlimFacts {
  project: string;
  slug: string;
  /** sum over the host directories; volumes are not measured — `du` over hundreds of volumes takes tens of minutes. */
  hostBytes: number;
}

async function shOut(cmd: string[]): Promise<{ ok: boolean; stdout: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const stdout = (await new Response(proc.stdout).text()).trim();
  return { ok: (await proc.exited) === 0, stdout };
}

async function duBytes(path: string): Promise<number> {
  const r = await shOut(["du", "-sk", path]);
  return r.ok ? (parseInt(r.stdout.split("\t")[0]!, 10) || 0) * 1024 : 0;
}

/** Volumes that plugin.docker() declares as its own for (project, slug); not dockerized → []. */
async function ownedVolumes(orch: string, project: string, slug: string, dir: string, branch: string): Promise<string[]> {
  const config = await resolveProjectConfig(orch, project);
  if (!config.docker?.image) return [];
  const plugin = await loadPlugin(config.plugin);
  if (!plugin.docker) return [];
  // docker() only reads worktreeDir/container — the rest of ctx is there for the type.
  const ctx: InstanceCtx = {
    orch, project, slug, branch,
    projectDir: projectDir(orch, project, await resolveProjectsDir(orch)), worktreeDir: dir, config,
    port: 0, offset: 0, container: containerName(project, slug), mode: "docker",
    settingsPath: null, extraPorts: {},
  };
  return plugin.docker(ctx).ownedVolumes ?? [];
}

export interface SlimPlan {
  items: SlimItem[];
  /** volumes of worktrees deleted bypassing `wt rm` — removed entirely, nothing to restore. */
  orphanVolumes: string[];
  /** dir-storage volume directories (under every configured `docker.storageDir` and `var/volumes`) with neither a worktree nor a base. */
  orphanVolumeDirs: string[];
}

async function dockerVolumes(): Promise<string[]> {
  const vl = await shOut(["docker", "volume", "ls", "--format", "{{.Name}}"]);
  return vl.ok ? vl.stdout.split("\n").filter(Boolean) : [];
}

/** True if the project has a config; false for an unlisted repo with no defaults.plugin. */
async function isConfigured(orch: string, project: string): Promise<boolean> {
  try {
    await resolveProjectConfig(orch, project);
    return true;
  } catch (e) {
    if (e instanceof UnlistedProjectError) return false;
    throw e;
  }
}

/** `listVolumes` is a test seam; default: `docker volume ls`. */
export async function collectSlimFacts(
  orch: string,
  deps: { listVolumes?: () => Promise<string[]> } = {},
): Promise<SlimPlan> {
  const projectsDir = await resolveProjectsDir(orch);
  const wts = await listWorktrees(orch);
  const running = new Set((await listRunningInstances(orch)).map((i) => `${i.project}/${i.slug}`));
  const allVolumes = await (deps.listVolumes ?? dockerVolumes)();
  const existingVolumes = new Set(allVolumes);

  // Volume owners are base and every worktrees/<p>/* directory on disk, not just what
  // git listed: a one-off `git worktree list` failure (empty output) would otherwise declare
  // the volumes of all worktrees orphans (which is exactly what happened on 2026-10-20).
  const owned = new Set<string>();
  const unlisted = new Set<string>();
  // every directory that may hold dir-storage volumes: the default plus each project's own
  const storageDirs = new Set<string>([resolve(orch, DEFAULT_STORAGE_DIR)]);
  for (const p of await listProjects(orch)) {
    if (!(await isConfigured(orch, p))) {
      // An unlisted repo (a docs or library repo) has no plugin to ask which volumes are
      // its own. Returning none would make all of its volumes orphans, so keep every
      // `wtdev-<p>-*` volume instead (conservative: it may also keep a `<p>-x` project's).
      unlisted.add(p);
      for (const v of allVolumes) if (v.startsWith(containerName(p, ""))) owned.add(v);
      continue;
    }
    const storageDir = (await resolveProjectConfig(orch, p)).docker?.storageDir;
    if (storageDir) storageDirs.add(resolve(orch, storageDir));
    for (const v of await ownedVolumes(orch, p, BASE_SLUG, projectDir(orch, p, projectsDir), "")) owned.add(v);
    const onDisk = await readdir(resolve(orch, "worktrees", p)).catch(() => [] as string[]);
    for (const slug of onDisk)
      for (const v of await ownedVolumes(orch, p, slug, resolve(orch, "worktrees", p, slug), "")) owned.add(v);
  }

  const items: SlimItem[] = [];
  for (const w of wts) {
    if (unlisted.has(w.project)) continue; // no plugin → its artifacts are unknown; volumes kept above
    const config = await resolveProjectConfig(orch, w.project);
    const plugin = await loadPlugin(config.plugin);
    const dirs: SlimFacts["dirs"] = [];
    for (const d of plugin.artifactDirs ?? []) {
      const path = resolve(w.path, d);
      if (existsSync(path)) dirs.push({ path, bytes: await duBytes(path) });
    }
    const declared = await ownedVolumes(orch, w.project, w.slug, w.path, w.branch);
    for (const v of declared) owned.add(v);
    // dir storage: the owned volumes are directories on the host — sized and removed like artifact dirs
    if (config.docker?.storage === "dir") {
      for (const v of declared) {
        const path = volumeDir(orch, v, config.docker.storageDir);
        if (existsSync(path)) dirs.push({ path, bytes: await duBytes(path) });
      }
    }
    const facts: SlimFacts = {
      running: running.has(`${w.project}/${w.slug}`),
      dirs,
      volumes: declared.filter((v) => existingVolumes.has(v)),
    };
    items.push({
      ...classifySlim(facts), ...facts,
      project: w.project, slug: w.slug,
      hostBytes: dirs.reduce((s, d) => s + d.bytes, 0),
    });
  }
  const orphanVolumeDirs: string[] = [];
  for (const sd of storageDirs) {
    const names = await readdir(sd).catch(() => [] as string[]);
    for (const v of findOrphanVolumes(names, owned)) orphanVolumeDirs.push(resolve(sd, v));
  }
  return { items, orphanVolumes: findOrphanVolumes(allVolumes, owned), orphanVolumeDirs };
}

/** `rm -rf` of orphan dir-storage volume directories. */
export async function removeVolumeDirs(dirs: string[]): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}

/** `docker volume rm` one by one; returns the ones docker refused to remove (held by a container). */
export async function removeVolumes(volumes: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const v of volumes) {
    if (!(await shOut(["docker", "volume", "rm", v])).ok) kept.push(v);
  }
  return kept;
}

export interface SlimOutcome {
  /** the instance was started between plan and apply — nothing was touched. */
  started: boolean;
  /** volumes docker refused to remove (held by a container) — they remain. */
  keptVolumes: string[];
}

export async function slimOne(orch: string, item: SlimItem): Promise<SlimOutcome> {
  const alive = await listRunningInstances(orch);
  if (alive.some((i) => i.project === item.project && i.slug === item.slug))
    return { started: true, keptVolumes: [] };
  for (const d of item.dirs) await rm(d.path, { recursive: true, force: true });
  return { started: false, keptVolumes: await removeVolumes(item.volumes) };
}
