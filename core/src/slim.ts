// wt slim — снос восстанавливаемых артефактов (зависимости, кэш сборки) во всех остановленных
// worktree, когда кончилось место. Код, git, env и порт не трогаются: docker-тома заново
// наполняет `wt start` (ensureDeps), host-каталоги — тот же `wt start` (ensureHostDeps).
// Заодно сносит тома-сироты: wtdev-тома без worktree и base (worktree удалён мимо `wt rm`).
// classifySlim — чистая функция над собранными фактами; fs/docker только в сборщике.

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { rm, readdir } from "node:fs/promises";
import { listWorktrees } from "./worktrees";
import { listProjects } from "./projects";
import { BASE_SLUG } from "./new-worktree";
import { listRunningInstances } from "./run";
import { resolveProjectConfig, resolveProjectsDir } from "./config";
import { loadPlugin, type InstanceCtx } from "./plugin";
import { containerName } from "./containers";
import { projectDir } from "./paths";

export interface SlimFacts {
  running: boolean;
  /** существующие host-каталоги из plugin.artifactDirs с размером. */
  dirs: { path: string; bytes: number }[];
  /** существующие docker-тома из plugin.docker().ownedVolumes. */
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

/** wtdev-тома, не принадлежащие ни одному существующему worktree и ни одному base (его снесли мимо `wt rm`). */
export function findOrphanVolumes(all: string[], owned: Set<string>): string[] {
  return all.filter((v) => v.startsWith("wtdev-") && !owned.has(v));
}

export interface SlimItem extends SlimDecision, SlimFacts {
  project: string;
  slug: string;
  /** сумма host-каталогов; тома не меряются — `du` по сотням томов идёт десятки минут. */
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

/** Тома, которые plugin.docker() объявляет своими для (project, slug); не dockerized → []. */
async function ownedVolumes(orch: string, project: string, slug: string, dir: string, branch: string): Promise<string[]> {
  const config = await resolveProjectConfig(orch, project);
  const plugin = await loadPlugin(config.plugin);
  if (!config.docker?.image || !plugin.docker) return [];
  // docker() читает только worktreeDir/container — остальной ctx для типа.
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
  /** тома удалённых мимо `wt rm` worktree — сносятся целиком, восстанавливать нечего. */
  orphanVolumes: string[];
}

export async function collectSlimFacts(orch: string): Promise<SlimPlan> {
  const projectsDir = await resolveProjectsDir(orch);
  const wts = await listWorktrees(orch);
  const running = new Set((await listRunningInstances(orch)).map((i) => `${i.project}/${i.slug}`));
  const vl = await shOut(["docker", "volume", "ls", "--format", "{{.Name}}"]);
  const allVolumes = vl.ok ? vl.stdout.split("\n").filter(Boolean) : [];
  const existingVolumes = new Set(allVolumes);

  // Хозяева томов — base и каждый каталог worktrees/<p>/* на диске, а не только то, что
  // перечислил git: разовый сбой `git worktree list` (пустой вывод) иначе объявил бы
  // сиротами тома всех worktree (так и случилось 2026-10-20).
  const owned = new Set<string>();
  for (const p of await listProjects(orch)) {
    for (const v of await ownedVolumes(orch, p, BASE_SLUG, projectDir(orch, p, projectsDir), "")) owned.add(v);
    const onDisk = await readdir(resolve(orch, "worktrees", p)).catch(() => [] as string[]);
    for (const slug of onDisk)
      for (const v of await ownedVolumes(orch, p, slug, resolve(orch, "worktrees", p, slug), "")) owned.add(v);
  }

  const items: SlimItem[] = [];
  for (const w of wts) {
    const plugin = await loadPlugin((await resolveProjectConfig(orch, w.project)).plugin);
    const dirs: SlimFacts["dirs"] = [];
    for (const d of plugin.artifactDirs ?? []) {
      const path = resolve(w.path, d);
      if (existsSync(path)) dirs.push({ path, bytes: await duBytes(path) });
    }
    const declared = await ownedVolumes(orch, w.project, w.slug, w.path, w.branch);
    for (const v of declared) owned.add(v);
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
  return { items, orphanVolumes: findOrphanVolumes(allVolumes, owned) };
}

/** `docker volume rm` по одному; возвращает те, что docker не отдал (держит контейнер). */
export async function removeVolumes(volumes: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const v of volumes) {
    if (!(await shOut(["docker", "volume", "rm", v])).ok) kept.push(v);
  }
  return kept;
}

export interface SlimOutcome {
  /** инстанс подняли между планом и apply — ничего не тронуто. */
  started: boolean;
  /** тома, которые docker не отдал (держит контейнер) — остались. */
  keptVolumes: string[];
}

export async function slimOne(orch: string, item: SlimItem): Promise<SlimOutcome> {
  const alive = await listRunningInstances(orch);
  if (alive.some((i) => i.project === item.project && i.slug === item.slug))
    return { started: true, keptVolumes: [] };
  for (const d of item.dirs) await rm(d.path, { recursive: true, force: true });
  return { started: false, keptVolumes: await removeVolumes(item.volumes) };
}
