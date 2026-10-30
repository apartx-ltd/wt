import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { registerSelfResolver } from "./self-resolve";

/** Docker-режим проекта: наличие image ⇒ проект запускается контейнером. */
export interface DockerConfig {
  image: string;
}

/** Членство проекта в core-стеке (`wt up`/`wt down`): какой slug поднимать. */
export interface CoreSpec {
  slug: string;
}

/** Конфиг одного проекта (декларативные данные, без логики). */
export interface ProjectConfig {
  /** имя плагин-пакета; если опущено — берётся defaults.plugin. */
  plugin?: string;
  /** присутствует ⇒ dockerized; image — единственный источник образа. */
  docker?: DockerConfig;
  /** присутствует ⇒ входит в core-стек. */
  core?: CoreSpec;
  /**
   * опц. env worktree-инстанса: пишется в `.env.worktree` (wt-managed, регенерируется на start).
   * Шаблоны: ${port}, ${offset}, ${branchSuffix} (ветка без `type/`, не-алфанум → `_`).
   * Base-checkout не получает — у него нет `.env.worktree`.
   */
  env?: Record<string, string>;
}

/** Конвенция веток workspace. */
export interface BranchConfig {
  /** ветка форка/интеграции (apartx: "develop"). */
  base: string;
  /** префикс worktree-веток и правило slug↔branch (apartx: "feature/"). */
  prefix: string;
}

export interface PortsConfig {
  /** шаг смещения портов между worktree (дефолт 10). */
  step?: number;
}

/** Декларативный конфиг workspace (корень `wt.config.ts`). */
export interface WorkspaceConfig {
  title?: string;
  /** имя проекта-апстрима для shorthand `--server` (apartx: "apartx-server"). */
  serverProject?: string;
  /** multi-repo: подкаталог с репозиториями (дефолт "projects"). Взаимоисключающe с `project`. */
  projectsDir?: string;
  /** single-repo: ровно один проект, корень репо = проект. Взаимоисключающe с `projects`. */
  project?: ProjectConfig;
  /** multi-repo: карта проектов по имени каталога. */
  projects?: Record<string, ProjectConfig>;
  branches?: BranchConfig;
  ports?: PortsConfig;
  /** дефолты, deep-merge'атся в каждый проект. */
  defaults?: ProjectConfig;
  /** межсервисный mesh: строки `consumer:target:mechanism:key`. */
  links?: string[];
}

/** Identity-хелпер: только для типизации `wt.config.ts`. */
export function defineWorkspace(config: WorkspaceConfig): WorkspaceConfig {
  return config;
}

/** Полностью разрешённый конфиг проекта (после defaults-merge; plugin гарантирован при валидном конфиге). */
export interface ResolvedProjectConfig extends ProjectConfig {
  plugin: string;
}

/** Разрешённый workspace: нормализованная карта проектов + дефолты. */
export interface ResolvedConfig {
  title?: string;
  serverProject?: string;
  projectsDir: string;
  projects: Record<string, ResolvedProjectConfig>;
  branches: BranchConfig;
  ports: { step: number };
  links: string[];
}

/** Рекурсивный merge: вложенные plain-объекты сливаются, скаляры/массивы перекрываются `override`. */
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
 * Разрешить декларативный конфиг: нормализовать single-repo (`project`) в карту из одного
 * элемента, deep-merge'нуть `defaults` в каждый проект, проставить дефолты branches/ports/dir.
 * `repoName` — имя single-repo проекта (basename корня репо); нужно только для single-repo формы.
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
    projects[name] = merged as ResolvedProjectConfig; // plugin-наличие проверяет валидация (Task 3)
  }
  return {
    title: config.title,
    serverProject: config.serverProject,
    projectsDir,
    projects,
    branches: config.branches ?? { base: "main", prefix: "feature/" },
    ports: { step: config.ports?.step ?? 10 },
    links: config.links ?? [],
  };
}

/** Проверить конфиг; кидает Error с человекочитаемым текстом. Возвращает разрешённый конфиг. */
export function validateConfig(config: WorkspaceConfig, repoName = "app"): ResolvedConfig {
  const hasProject = config.project !== undefined;
  const hasProjects = config.projects !== undefined;
  if (hasProject === hasProjects) {
    throw new Error("wt.config: задайте ровно один из `project` / `projects`");
  }
  if (hasProject && config.projectsDir !== undefined) {
    throw new Error("wt.config: `projectsDir` несовместим с single-repo `project`");
  }
  const resolved = resolveConfig(config, repoName);
  for (const [name, pc] of Object.entries(resolved.projects)) {
    if (!pc.plugin) throw new Error(`wt.config: проект ${name}: не задан plugin (ни в проекте, ни в defaults)`);
  }
  return resolved;
}

/**
 * Загрузить и проверить `<orch>/wt.config.ts` (single-repo: корень репо). Кидает, если файла
 * нет или конфиг невалиден. `repoName` — basename корня (для single-repo формы).
 */
export async function loadConfig(orch: string, repoName = "app"): Promise<ResolvedConfig> {
  const path = resolve(orch, "wt.config.ts");
  registerSelfResolver(); // `import … from "@apartx/wt"` в конфиге — без node_modules у потребителя
  const mod = await import(path).catch((e) => {
    throw new Error(`wt.config: не удалось загрузить ${path}: ${(e as Error).message}`);
  });
  const config = (mod.default ?? mod) as WorkspaceConfig;
  return validateConfig(config, repoName);
}

/**
 * Конфиг ОДНОГО проекта для (project) в оркестраторе `orch`. Если у корня есть
 * `wt.config.ts` — берём оттуда (config-driven, M1+). Иначе синтезируем паритетный
 * host-only конфиг (`@apartx/wt/plugin-meteor`, без docker), чтобы start/new работали в
 * тестах с временными orch-каталогами и в single-repo без файла.
 */
export async function resolveProjectConfig(orch: string, project: string): Promise<ResolvedProjectConfig> {
  if (existsSync(resolve(orch, "wt.config.ts"))) {
    const cfg = await loadConfig(orch, basename(orch));
    const pc = cfg.projects[project];
    if (pc) return pc;
    // M1: конфиг аддитивен — он объявляет/переопределяет перечисленные (dockerized core)
    // проекты, а все прочие (apartx-whatsapp/-spaces-host/…) сохраняют поведение из
    // констант через тот же фоллбэк, что и при отсутствии конфига. M2 переедет все
    // проекты в конфиг и сможет ужесточить это до throw-on-undeclared.
  }
  // Фоллбэк-паритет: host-only meteor для неперечисленных/без-конфига проектов.
  return fallbackProjectConfig(project);
}

/** projectsDir разрешённого workspace ("." для single-repo, иначе "projects"); "projects" если конфига нет. */
export async function resolveProjectsDir(orch: string): Promise<string> {
  if (!existsSync(resolve(orch, "wt.config.ts"))) return "projects";
  const cfg = await loadConfig(orch, basename(orch));
  return cfg.projectsDir;
}

/** Имя проекта-апстрима для `--server` из `<orch>/wt.config.ts`; null если конфига/поля нет. */
export async function resolveServerProject(orch: string): Promise<string | null> {
  if (!existsSync(resolve(orch, "wt.config.ts"))) return null;
  const cfg = await loadConfig(orch, basename(orch));
  return cfg.serverProject ?? null;
}

/**
 * Имена всех dockerized-проектов (с `docker.image`) из `<orch>/wt.config.ts` —
 * стабильный источник индекса для базовых доп-портов (deterministicAuxBasePort).
 * Конфига нет (тесты/single-repo без файла) ⇒ []. Apartx-специфики в движке нет.
 */
export async function resolveDockerizedProjects(orch: string): Promise<string[]> {
  if (!existsSync(resolve(orch, "wt.config.ts"))) return [];
  const cfg = await loadConfig(orch, basename(orch));
  return Object.entries(cfg.projects)
    .filter(([, pc]) => pc.docker?.image)
    .map(([name]) => name);
}

/**
 * Core-стек (`wt up`/`wt down`): пары `[project, slug]` для проектов с `core` в
 * `<orch>/wt.config.ts`, отсортированы по имени проекта (детерминизм). Конфига нет ⇒ [].
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
 * Спеки межсервисных линков (`consumer:target:mechanism:key`) из `<orch>/wt.config.ts`.
 * Конфига нет (тесты/single-repo без файла) ⇒ []. Apartx-специфики в движке нет.
 */
export async function resolveLinkSpecs(orch: string): Promise<string[]> {
  if (!existsSync(resolve(orch, "wt.config.ts"))) return [];
  return (await loadConfig(orch, basename(orch))).links;
}

/** Паритетный конфиг при отсутствии записи в `wt.config.ts`: host-meteor, без docker. */
function fallbackProjectConfig(_project: string): ResolvedProjectConfig {
  return { plugin: "@apartx/wt/plugin-meteor" };
}
