import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { registerSelfResolver } from "./self-resolve";

/** Docker mode of a project: an `image` present ⇒ the project runs as a container. */
export interface DockerConfig {
  image: string;
}

/** Membership of a project in the core stack (`wt up`/`wt down`): which slug to bring up. */
export interface CoreSpec {
  slug: string;
}

/** Config of a single project (declarative data, no logic). */
export interface ProjectConfig {
  /** plugin package name; when omitted, defaults.plugin is used. */
  plugin?: string;
  /** present ⇒ dockerized; `image` is the single source of the image. */
  docker?: DockerConfig;
  /** present ⇒ part of the core stack. */
  core?: CoreSpec;
  /**
   * optional env of a worktree instance: written to `.env.worktree` (wt-managed, regenerated on start).
   * Templates: ${port}, ${offset}, ${branchSuffix} (branch without `type/`, non-alphanumerics → `_`).
   * The base checkout does not get it — it has no `.env.worktree`.
   */
  env?: Record<string, string>;
}

/** Branch convention of the workspace. */
export interface BranchConfig {
  /** fork/integration branch (apartx: "develop"). */
  base: string;
  /** prefix of worktree branches and the slug↔branch rule (apartx: "feature/"). */
  prefix: string;
}

export interface PortsConfig {
  /** port offset step between worktrees (default 10). */
  step?: number;
}

/** Declarative workspace config (root `wt.config.ts`). */
export interface WorkspaceConfig {
  title?: string;
  /** name of the upstream project for the `--server` shorthand (apartx: "apartx-server"). */
  serverProject?: string;
  /** multi-repo: subdirectory holding the repositories (default "projects"). Mutually exclusive with `project`. */
  projectsDir?: string;
  /** single-repo: exactly one project, the repo root is the project. Mutually exclusive with `projects`. */
  project?: ProjectConfig;
  /** multi-repo: map of projects keyed by directory name. */
  projects?: Record<string, ProjectConfig>;
  branches?: BranchConfig;
  ports?: PortsConfig;
  /** defaults, deep-merged into every project. */
  defaults?: ProjectConfig;
  /** inter-service mesh: `consumer:target:mechanism:key` strings. */
  links?: string[];
}

/** Identity helper: only for typing `wt.config.ts`. */
export function defineWorkspace(config: WorkspaceConfig): WorkspaceConfig {
  return config;
}

/** Fully resolved project config (after the defaults merge; plugin is guaranteed for a valid config). */
export interface ResolvedProjectConfig extends ProjectConfig {
  plugin: string;
}

/** Resolved workspace: normalized project map + defaults. */
export interface ResolvedConfig {
  title?: string;
  serverProject?: string;
  projectsDir: string;
  projects: Record<string, ResolvedProjectConfig>;
  branches: BranchConfig;
  ports: { step: number };
  links: string[];
  /** `defaults` as written (empty object when unset) — the config of a project the file does not list. */
  defaults: ProjectConfig;
}

/** Recursive merge: nested plain objects are merged, scalars/arrays are replaced by `override`. */
export function deepMerge<T>(base: T, override: Partial<T>): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(override ?? {})) {
    const b = (out as any)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)) {
      (out as any)[k] = deepMerge(b, v as any);
    } else if (v !== undefined) {
      (out as any)[k] = v;
    }
  }
  return out;
}

/**
 * Resolve the declarative config: normalize single-repo (`project`) into a one-entry map,
 * deep-merge `defaults` into every project, fill in defaults for branches/ports/dir.
 * `repoName` — name of the single-repo project (basename of the repo root); only needed for the single-repo form.
 */
export function resolveConfig(config: WorkspaceConfig, repoName = "app"): ResolvedConfig {
  const projectsDir = config.project ? "." : (config.projectsDir ?? "projects");
  const raw: Record<string, ProjectConfig> = config.project
    ? { [repoName]: config.project }
    : (config.projects ?? {});
  const defaults = config.defaults ?? {};
  const projects: Record<string, ResolvedProjectConfig> = {};
  for (const [name, pc] of Object.entries(raw)) {
    const merged = deepMerge<ProjectConfig>(defaults, pc);
    projects[name] = merged as ResolvedProjectConfig; // presence of plugin is checked by validation (Task 3)
  }
  return {
    title: config.title,
    serverProject: config.serverProject,
    projectsDir,
    projects,
    branches: config.branches ?? { base: "main", prefix: "feature/" },
    ports: { step: config.ports?.step ?? 10 },
    links: config.links ?? [],
    defaults,
  };
}

/** Validate the config; throws an Error with a human-readable message. Returns the resolved config. */
export function validateConfig(config: WorkspaceConfig, repoName = "app"): ResolvedConfig {
  const hasProject = config.project !== undefined;
  const hasProjects = config.projects !== undefined;
  if (hasProject === hasProjects) {
    throw new Error("wt.config: set exactly one of `project` / `projects`");
  }
  if (hasProject && config.projectsDir !== undefined) {
    throw new Error("wt.config: `projectsDir` is incompatible with single-repo `project`");
  }
  const resolved = resolveConfig(config, repoName);
  for (const [name, pc] of Object.entries(resolved.projects)) {
    if (!pc.plugin) throw new Error(`wt.config: project ${name}: no plugin set (neither in the project nor in defaults)`);
  }
  return resolved;
}

/**
 * Load and validate `<orch>/wt.config.ts` (single-repo: the repo root). Throws if the file
 * is missing or the config is invalid. `repoName` — basename of the root (for the single-repo form).
 */
export async function loadConfig(orch: string, repoName = "app"): Promise<ResolvedConfig> {
  const path = resolve(orch, "wt.config.ts");
  registerSelfResolver(); // lets the config `import … from "@apartx/wt"` without the consumer having node_modules
  const mod = await import(path).catch((e) => {
    throw new Error(`wt.config: failed to load ${path}: ${(e as Error).message}`);
  });
  const config = (mod.default ?? mod) as WorkspaceConfig;
  return validateConfig(config, repoName);
}

/**
 * Config of ONE project (project) in orchestrator `orch`. If the root has a
 * `wt.config.ts`, take it from there: a listed project gets its entry merged over
 * `defaults`; an unlisted one gets `defaults` alone (as if listed with `{}`), and is an
 * error when `defaults.plugin` is unset. Without a `wt.config.ts` synthesize a host-only
 * config (`@apartx/wt/plugin-meteor`, no docker) so that start/new work in tests with
 * temporary orch directories.
 */
export async function resolveProjectConfig(orch: string, project: string): Promise<ResolvedProjectConfig> {
  if (!existsSync(resolve(orch, "wt.config.ts"))) return fallbackProjectConfig(project);
  const cfg = await loadConfig(orch, basename(orch));
  const pc = cfg.projects[project];
  if (pc) return pc;
  if (!cfg.defaults.plugin) {
    throw new Error(`wt.config: project "${project}" is not listed and defaults.plugin is unset`);
  }
  return deepMerge<ProjectConfig>(cfg.defaults, {}) as ResolvedProjectConfig;
}

/** projectsDir of the resolved workspace ("." for single-repo, otherwise "projects"); "projects" when there is no config. */
export async function resolveProjectsDir(orch: string): Promise<string> {
  if (!existsSync(resolve(orch, "wt.config.ts"))) return "projects";
  const cfg = await loadConfig(orch, basename(orch));
  return cfg.projectsDir;
}

/** Name of the upstream project for `--server` from `<orch>/wt.config.ts`; null if there is no config/field. */
export async function resolveServerProject(orch: string): Promise<string | null> {
  if (!existsSync(resolve(orch, "wt.config.ts"))) return null;
  const cfg = await loadConfig(orch, basename(orch));
  return cfg.serverProject ?? null;
}

/**
 * Names of all dockerized projects (with `docker.image`) from `<orch>/wt.config.ts` —
 * a stable index source for the base aux ports (deterministicAuxBasePort).
 * No config (tests / single-repo without the file) ⇒ []. No workspace-specific names in the engine.
 */
export async function resolveDockerizedProjects(orch: string): Promise<string[]> {
  if (!existsSync(resolve(orch, "wt.config.ts"))) return [];
  const cfg = await loadConfig(orch, basename(orch));
  return Object.entries(cfg.projects)
    .filter(([, pc]) => pc.docker?.image)
    .map(([name]) => name);
}

/**
 * Core stack (`wt up`/`wt down`): `[project, slug]` pairs for projects with `core` in
 * `<orch>/wt.config.ts`, sorted by project name (determinism). No config ⇒ [].
 */
export async function resolveCoreStack(orch: string): Promise<Array<[string, string]>> {
  if (!existsSync(resolve(orch, "wt.config.ts"))) return [];
  const cfg = await loadConfig(orch, basename(orch));
  return Object.entries(cfg.projects)
    .filter(([, pc]) => pc.core)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, pc]) => [name, pc.core!.slug] as [string, string]);
}

/**
 * Inter-service link specs (`consumer:target:mechanism:key`) from `<orch>/wt.config.ts`.
 * No config (tests / single-repo without the file) ⇒ []. No workspace-specific names in the engine.
 */
export async function resolveLinkSpecs(orch: string): Promise<string[]> {
  if (!existsSync(resolve(orch, "wt.config.ts"))) return [];
  return (await loadConfig(orch, basename(orch))).links;
}

/** Config when there is no `wt.config.ts` at all: host meteor, no docker. */
function fallbackProjectConfig(_project: string): ResolvedProjectConfig {
  return { plugin: "@apartx/wt/plugin-meteor" };
}
