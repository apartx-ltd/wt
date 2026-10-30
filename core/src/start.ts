import { resolve, dirname } from "node:path";
import { existsSync, openSync } from "node:fs";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { spawn as cpSpawn } from "node:child_process";
import { containerName, dockerRemove } from "./containers";
import { BASE_SLUG, regenerateWorktreeEnvPreserving } from "./new-worktree";
import { resolveProjectConfig, resolveDockerizedProjects, resolveProjectsDir, type ResolvedProjectConfig } from "./config";
import { loadPlugin, type InstanceCtx, type StackPlugin } from "./plugin";
import { applyLinks } from "./links";
import {
  projectDir,
  worktreeDir,
  runFilePath,
  logFilePath,
  envFilePath,
  ovrFilePath,
  mergedEnvPath,
  dockerSettingsPath,
  runDir,
} from "./paths";
import { resolveBasePort, resolveAuxBasePort, readWorktreePort, readEnvValue } from "./ports";
import { mergeEnvFiles } from "./env-merge";
import { ensureDeps, ensureHostDeps } from "./deps";
import {
  parseRunState,
  isInstanceAlive,
  formatRunState,
  defaultProbes,
  type AliveProbes,
} from "./run";

export interface DockerRunArgs {
  /** имя контейнера (wtdev-<p>-<slug>) */
  container: string;
  port: number;
  /** merged env-file (--env-file) */
  envFile: string;
  /** доп-порты (имя→номер) из plugin.extraPorts; каждый публикуется `-p <n>:<n>`. */
  extraPorts?: Record<string, number>;
  /** bind-mounts/тома (`-v`), которые даёт plugin.docker(ctx).mounts. */
  mounts: string[];
  /** add-hosts (`--add-host`): plugin.docker(ctx).addHosts + динамический dev-host, в порядке вызова. */
  addHosts: string[];
  /** строка `sh -c <innerCmd>` (plugin.devCommand(ctx).argv.join(" ")). */
  innerCmd: string;
  /** docker-образ (ctx.config.docker.image). */
  image: string;
  /** опц. ro-mount отрендеренного settings (var/run/<p>-<slug>.settings.docker.json → /opt/app/.wt-settings.json). */
  settingsMount?: string | null;
  /** статические `-e KEY=VALUE`, которые даёт plugin.docker(ctx).env (порядок вставки, перед generic NODE_OPTIONS). */
  dockerEnv?: Record<string, string>;
}

/**
 * argv для `docker run` dockerized-инстанса (после слова `docker`). Ядро добавляет
 * generic-флаги (`-d --name`, форс-поллинг hot-reload, ipv4first DNS, проброс
 * основного порта + по одному на каждый extraPort, env-file); add-hosts, тома,
 * образ и inner-cmd приходят от плагина (plugin.docker / plugin.devCommand).
 * Паритет с блоком `docker run -d --name …` в cmd_start.
 */
export function buildDockerRunArgs(a: DockerRunArgs): string[] {
  const args = ["run", "-d", "--name", a.container];
  for (const h of a.addHosts) args.push("--add-host", h);
  for (const [k, v] of Object.entries(a.dockerEnv ?? {})) args.push("-e", `${k}=${v}`);
  args.push(
    "-e", "NODE_OPTIONS=--dns-result-order=ipv4first",
    "-p", `${a.port}:${a.port}`,
  );
  for (const p of Object.values(a.extraPorts ?? {})) args.push("-p", `${p}:${p}`);
  args.push("--env-file", a.envFile);
  for (const m of a.mounts) args.push("-v", m);
  if (a.settingsMount) args.push("-v", `${a.settingsMount}:/opt/app/.wt-settings.json:ro`);
  args.push("-w", "/opt/app", a.image, "sh", "-c", a.innerCmd);
  return args;
}

/**
 * docker-env для контейнера с учётом базового checkout'а. База (slug "base") не имеет
 * `.env.worktree`, несущего HMR/extra env → инжектим plugin.envLines (offset 0 ⇒
 * детерминированный base HMR) как `-e`. Worktree получает их из env-file (renderEnvFile),
 * поэтому для них envLines НЕ добавляем — docker-argv worktree остаётся без изменений.
 */
export function baseCheckoutDockerEnv(
  slug: string,
  specEnv: Record<string, string> | undefined,
  pluginEnvLines: string[],
): Record<string, string> {
  const dockerEnv = { ...(specEnv ?? {}) };
  if (slug === BASE_SLUG) {
    for (const line of pluginEnvLines) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m) dockerEnv[m[1]!] = m[2]!;
    }
  }
  return dockerEnv;
}

/**
 * Remap одной env-строки для контейнера: `localhost`/`127.0.0.1`→host (КРОМЕ ROOT_URL).
 * Стек-специфичные правки (напр. mongo directConnection) даёт plugin.docker().envLineFilter,
 * который ядро применяет ПОСЛЕ generic-remap. Паритет sed+awk в render_env_file.
 */
export function remapEnvLine(line: string, host: string, filter?: (l: string) => string): string {
  let l = line;
  if (!l.startsWith("ROOT_URL=")) l = l.replaceAll("localhost", host).replaceAll("127.0.0.1", host);
  return filter ? filter(l) : l;
}

/**
 * Deep-remap host'ов в settings-объекте: `localhost`/`127.0.0.1`→host во всех
 * строковых листьях КРОМЕ поддерева `public` (оно уходит в браузер as-is). Паритет
 * node-walk в docker_settings.
 */
export function remapSettingsHosts(node: unknown, host: string, inPublic = false): unknown {
  if (Array.isArray(node)) return node.map((v) => remapSettingsHosts(v, host, inPublic));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.keys(node as Record<string, unknown>).map((k) => [
        k,
        remapSettingsHosts((node as Record<string, unknown>)[k], host, inPublic || k === "public"),
      ]),
    );
  }
  if (typeof node === "string") return inPublic ? node : node.replaceAll("localhost", host).replaceAll("127.0.0.1", host);
  return node;
}

export interface HostMeteorArgs {
  /** абсолютный путь base `.env` проекта */
  baseEnv: string;
  /** `.env.worktree` присутствует (относительный, cwd = worktree) */
  hasWorktreeEnv: boolean;
  /** абсолютный путь env-overlay линка (var/env/<p>-<slug>.env) или null */
  envOverlay?: string | null;
  /** inner-команда для `sh -c` (plugin.devCommand(ctx).argv.join(" ")), напр. `meteor run --port $PORT`. */
  innerCmd: string;
}

/**
 * argv host-старта: `npx dotenvx run <fchain> -- sh -c "<innerCmd>"`. Цепочка dotenvx
 * (левый выигрывает): env-overlay → .env.worktree → base .env. innerCmd даёт плагин
 * (plugin.devCommand). Паритет meteor_cmd.
 */
export function buildHostMeteorArgs(c: HostMeteorArgs): string[] {
  const f: string[] = [];
  if (c.envOverlay) f.push("-f", c.envOverlay);
  if (c.hasWorktreeEnv) f.push("-f", ".env.worktree");
  f.push("-f", c.baseEnv);
  return ["npx", "dotenvx", "run", ...f, "--", "sh", "-c", c.innerCmd];
}

const buildLockDir = (orch: string): string => resolve(runDir(orch), ".build.lock");

/** Сериализация фазы сборки (mkdir-spinlock; забор протухшего лока мёртвого владельца). Паритет acquire_build_lock. */
async function acquireBuildLock(orch: string, probes: AliveProbes): Promise<void> {
  await mkdir(runDir(orch), { recursive: true });
  const lock = buildLockDir(orch);
  let waited = 0;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      const holder = Number.parseInt((await readFile(resolve(lock, "owner"), "utf8").catch(() => "")).trim(), 10);
      if (holder && !probes.pidAlive(holder)) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      await Bun.sleep(2000);
      waited += 2;
      if (waited >= 1200) await rm(lock, { recursive: true, force: true });
    }
  }
  await writeFile(resolve(lock, "owner"), String(process.pid));
}

async function releaseBuildLock(orch: string): Promise<void> {
  await rm(buildLockDir(orch), { recursive: true, force: true }).catch(() => {});
}

/** Ждать ответа порта (сборка прошла) или смерти процесса/таймаута. Паритет wait_port_up. */
export async function waitPortUp(
  port: number,
  opts: { pid?: number; deadlineMs?: number; probes?: AliveProbes } = {},
): Promise<boolean> {
  const probes = opts.probes ?? defaultProbes;
  const deadline = Date.now() + (opts.deadlineMs ?? 600_000);
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(3000) });
      return true; // любой HTTP-ответ = поднялся
    } catch {
      /* нет ответа — продолжаем */
    }
    if (opts.pid !== undefined && !probes.pidAlive(opts.pid)) return false;
    await Bun.sleep(4000);
  }
  return false;
}

export async function gitBranch(dir: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, "branch", "--show-current"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

/** Запустить процесс отвязанным лидером своей process-group (kill -- -PGID при stop), лог → файл. */
export function spawnDetached(cmd: string, args: string[], cwd: string, logPath: string, env?: Record<string, string>): number {
  const fd = openSync(logPath, "a");
  const child = cpSpawn(cmd, args, {
    cwd, detached: true, stdio: ["ignore", fd, fd],
    env: env ? { ...process.env, ...env } : process.env,
  });
  child.unref();
  if (!child.pid) throw new Error("не удалось запустить процесс");
  return child.pid;
}

/** mDNS-имя dev-машины (<LocalHostName>.local); null на non-mac. Паритет dev_host. */
export async function devHost(): Promise<string | null> {
  const proc = Bun.spawn(["scutil", "--get", "LocalHostName"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out ? `${out}.local` : null;
}

/**
 * Запустить команду со стримингом stdio; кинуть при ненулевом коде.
 * `hints` — подсказка по коду возврата: docker печатает причину в свой stderr, но она
 * тонет выше по логу, поэтому дублируем самое частое прямо в текст ошибки.
 */
export async function shInherit(cmd: string[], hints?: Record<number, string>): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const code = await proc.exited;
  if (code === 0) return;
  const hint = hints?.[code];
  throw new Error(`команда завершилась с кодом ${code}: ${cmd.join(" ")}${hint ? `\n${hint}` : ""}`);
}

/** Скрейп localhost-дефолтов `process.env.X or 'scheme://…localhost…'` из исходников worktree (первый per-ключ). */
async function scrapeLocalhostDefaults(dir: string): Promise<Map<string, string>> {
  const re = "process\\.env\\.[A-Z_0-9]+ *(or|\\|\\||\\?\\?) *['\"][a-z]+://[^'\"]*localhost[^'\"]*['\"]";
  const proc = Bun.spawn(
    ["grep", "-rhoE", re, dir, "--include=*.coffee", "--include=*.js", "--include=*.ts", "--exclude-dir=node_modules", "--exclude-dir=.meteor"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const raw = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  const extract = /process\.env\.([A-Z_0-9]+).*['"]([a-z]+:\/\/[^'"]*localhost[^'"]*)['"]/;
  const lines = raw ? [...new Set(raw.split("\n").filter(Boolean))].sort() : [];
  const out = new Map<string, string>();
  for (const line of lines) {
    const m = extract.exec(line);
    if (m && !out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * Отрендерить merged env-file для контейнера (`var/run/<p>-<slug>.env.merged`): dotenvx
 * из ГЛАВНОГО checkout (там node_modules/dotenvx) → отфильтровать по ключам файлов →
 * remapEnvLine → доскрейпить недостающие localhost-дефолты. Паритет render_env_file.
 */
export async function renderEnvFile(
  orch: string,
  project: string,
  slug: string,
  host: string,
  envLineFilter?: (l: string) => string,
  projectsDir = "projects",
): Promise<string> {
  const pdir = projectDir(orch, project, projectsDir);
  const dir = slug === BASE_SLUG ? pdir : worktreeDir(orch, project, slug);
  const wenv = resolve(dir, ".env.worktree");
  const envovr = envFilePath(orch, project, slug);
  const out = mergedEnvPath(orch, project, slug);

  const files = [resolve(pdir, ".env")];
  if (existsSync(wenv)) files.unshift(wenv);
  if (existsSync(envovr)) files.unshift(envovr);
  const keys = new Set<string>();
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of (await readFile(f, "utf8")).split("\n")) {
      // допускаем shell-стиль `export KEY=...` (ведущий `export ` снимается)
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      if (m) keys.add(m[1]!);
    }
  }

  const fchain: string[] = [];
  if (existsSync(envovr)) fchain.push("-f", envovr);
  if (existsSync(wenv)) fchain.push("-f", wenv);
  fchain.push("-f", ".env");
  const proc = Bun.spawn(["npx", "dotenvx", "run", ...fchain, "--", "env"], { cwd: pdir, stdout: "pipe", stderr: "ignore" });
  const raw = await new Response(proc.stdout).text();
  await proc.exited;

  const values = new Map<string, string>();
  const addLine = (line: string) => {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || !keys.has(m[1]!)) return;
    values.set(m[1]!, m[2]!);
  };
  for (const line of raw.split("\n")) addLine(line);
  // dotenvx экспортирует только ключи из "главного" файла (envovr → wenv → .env).
  // Дописываем недостающие из wenv/envovr вручную, чтобы PORT-переопределения
  // и HMR-порты не терялись, когда их нет в base .env.
  // Ограничение: здесь берутся сырые значения из файлов (без раскрытия ${VAR}
  // и без снятия кавычек dotenvx). Для числовых портов/URL это безопасно.
  for (const f of [wenv, envovr]) {
    if (!existsSync(f)) continue;
    for (const line of (await readFile(f, "utf8")).split("\n")) addLine(line);
  }
  // Фолбэк на сырой base `.env`: dotenvx выше мог не отработать вообще — он резолвится
  // через `npx` и есть в node_modules только у проектов, где объявлен в зависимостях
  // (не-Meteor стек его не тащит; stderr подавлен, так что провал молчаливый). Без этого
  // весь конфиг проекта тихо терялся, а инстанс поднимался на одних scrape-дефолтах.
  // Только недостающие ключи: там, где dotenvx сработал, его значения точнее (раскрытые
  // ${VAR}, снятые кавычки).
  {
    const baseEnv = resolve(pdir, ".env");
    if (existsSync(baseEnv)) {
      for (const line of (await readFile(baseEnv, "utf8")).split("\n")) {
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (m && !values.has(m[1]!)) values.set(m[1]!, m[2]!);
      }
    }
  }
  for (const [k, v] of await scrapeLocalhostDefaults(dir)) {
    if (values.has(k)) continue;
    values.set(k, v);
  }
  const remapped = [...values.entries()].map(([k, v]) => remapEnvLine(`${k}=${v}`, host, envLineFilter));
  const content = remapped.length ? remapped.join("\n") + "\n" : "";
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, content);
  return out;
}

/** Отрендерить settings для контейнера (public-aware remap) → путь монтирования или null. Паритет docker_settings. */
export async function renderDockerSettings(orch: string, project: string, slug: string, host: string, projectsDir = "projects"): Promise<string | null> {
  const dir = slug === BASE_SLUG ? projectDir(orch, project, projectsDir) : worktreeDir(orch, project, slug);
  let src = "";
  if (existsSync(ovrFilePath(orch, project, slug))) src = ovrFilePath(orch, project, slug);
  else if (existsSync(resolve(dir, "settings", "settings.json"))) src = resolve(dir, "settings", "settings.json");
  else if (existsSync(resolve(dir, "settings.json"))) src = resolve(dir, "settings.json");
  if (!src) return null;
  const out = dockerSettingsPath(orch, project, slug);
  const remapped = remapSettingsHosts(JSON.parse(await readFile(src, "utf8")), host);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(remapped, null, 2) + "\n");
  return out;
}

export interface StartOptions {
  /** "all" — все апстримы потребителя; иначе имя одной цели-апстрима (фильтр). */
  link?: "all" | string;
  /** slug целевых worktree'ов для линков (по умолчанию = свой slug). */
  linkSlug?: string;
}

export interface StartResult {
  project: string;
  slug: string;
  port: number;
  pid: number | null;
  container: string | null;
  branch: string;
  portUp: boolean;
}

/**
 * `wt start` (background). Общие проверки → linkи → ветвление host (detached-процесс)
 * / docker (контейнер). Паритет cmd_start. Гейтит host-сборку build-lock'ом, пишет
 * runfile, ждёт порт.
 */
export async function startInstance(
  orch: string,
  project: string,
  slug: string,
  opts: StartOptions = {},
  probes: AliveProbes = defaultProbes,
): Promise<StartResult> {
  const projectsDir = await resolveProjectsDir(orch);
  const isBase = slug === BASE_SLUG;
  const dir = isBase ? projectDir(orch, project, projectsDir) : worktreeDir(orch, project, slug);
  if (!existsSync(dir)) throw new Error(`нет worktree: ${project}/${slug} (создай: wt new ${project} ${slug})`);

  const rf = runFilePath(orch, project, slug);
  const existing = await parseRunState(rf);
  if (existing && (await isInstanceAlive(existing, probes))) {
    const who = existing.container ?? `PID ${existing.pid ?? "?"}`;
    throw new Error(`${project}/${slug} уже запущен (${who}, порт ${existing.port ?? "?"})`);
  }

  if (!isBase) {
    await regenerateWorktreeEnvPreserving(orch, project, await gitBranch(dir), dir);
  }

  if (opts.link) {
    await applyLinks(orch, project, slug, opts.linkSlug ?? slug, opts.link === "all" ? undefined : opts.link);
  }

  const port = isBase ? await resolveBasePort(projectDir(orch, project, projectsDir)) : await readWorktreePort(dir);
  if (port === null) throw new Error(`${project}/${slug}: не нашёл PORT (base .env / .env.worktree)`);
  const branch = await gitBranch(dir);

  const config = await resolveProjectConfig(orch, project);
  return config.docker?.image
    ? startDockerized(orch, project, slug, dir, port, branch, projectsDir)
    : startHost(orch, project, slug, dir, port, branch, probes, projectsDir);
}

/** Резолв host-`--settings` (ovr → repo settings/settings.json → settings.json) или null. */
function resolveHostSettings(orch: string, project: string, slug: string, dir: string): string | null {
  if (existsSync(ovrFilePath(orch, project, slug))) return ovrFilePath(orch, project, slug);
  if (existsSync(resolve(dir, "settings", "settings.json"))) return "settings/settings.json";
  if (existsSync(resolve(dir, "settings.json"))) return "settings.json";
  return null;
}

/**
 * Собрать `InstanceCtx` для плагина. port/offset/container/extraPorts даёт ядро;
 * settingsPath — per-mode (host: абс/репо `--settings`-путь, docker: `.wt-settings.json`
 * когда есть mount). Для host-режима offset/extraPorts не используются meteor-плагином,
 * но контекст типобезопасен.
 */
function buildInstanceCtx(args: {
  orch: string;
  project: string;
  slug: string;
  dir: string;
  branch: string;
  config: ResolvedProjectConfig;
  port: number;
  offset: number;
  container: string;
  mode: "host" | "docker";
  settingsPath: string | null;
  extraPorts: Record<string, number>;
  projectsDir?: string;
}): InstanceCtx {
  return {
    orch: args.orch,
    project: args.project,
    slug: args.slug,
    branch: args.branch,
    projectDir: projectDir(args.orch, args.project, args.projectsDir),
    worktreeDir: args.dir,
    config: args.config,
    port: args.port,
    offset: args.offset,
    container: args.container,
    mode: args.mode,
    settingsPath: args.settingsPath,
    extraPorts: args.extraPorts,
  };
}

/**
 * Host-старт argv. Плагин описывает inner-cmd (`plugin.devCommand(ctx).argv`); ядро
 * оборачивает: при `envInjection==="dotenvx"` — в dotenvx-цепочку (env-overlay → .env.worktree
 * → base .env) + `sh -c <inner>` (паритет meteor_cmd); иначе env-словарём inline.
 */
export async function buildHostDevArgs(args: {
  orch: string;
  project: string;
  slug: string;
  dir: string;
  branch: string;
  port: number;
  plugin: StackPlugin;
  config: ResolvedProjectConfig;
  projectsDir?: string;
}): Promise<{ argv: string[]; env?: Record<string, string> }> {
  const { orch, project, slug, dir, projectsDir } = args;
  const settings = resolveHostSettings(orch, project, slug, dir);
  const ctx = buildInstanceCtx({
    orch, project, slug, dir, branch: args.branch, config: args.config,
    port: args.port, offset: 0, container: containerName(project, slug),
    mode: "host", settingsPath: settings, extraPorts: {}, projectsDir,
  });
  const cmd = args.plugin.devCommand(ctx);
  const inner = cmd.argv.join(" ");
  // Inject the engine-resolved PORT as a fallback. The base checkout (slug "base") has no
  // `.env.worktree` carrying a deterministic PORT, and a project's base `.env` often omits
  // PORT entirely (e.g. apartx-spaces keeps it in package.json). For meteor (`$PORT` in the
  // dotenvx innerCmd) that left $PORT empty → "the --port option needs a value" — it only
  // "worked" before by inheriting a stray PORT from the parent. PORT is set FIRST so any
  // file-provided PORT (.env / .env.worktree, which equals args.port for worktrees) wins;
  // dotenvx likewise won't override this already-set env var, so the resolved port governs.
  if (args.plugin.envInjection === "dotenvx") {
    const envOverlay = existsSync(envFilePath(orch, project, slug)) ? envFilePath(orch, project, slug) : null;
    const hasWtree = slug !== BASE_SLUG && existsSync(resolve(dir, ".env.worktree"));
    return {
      argv: buildHostMeteorArgs({ baseEnv: resolve(projectDir(orch, project, projectsDir), ".env"), hasWorktreeEnv: hasWtree, envOverlay, innerCmd: inner }),
      env: { PORT: String(args.port) },
    };
  }
  // inline: ядро само наслаивает env-файлы (base .env → .env.worktree → env-overlay линка;
  // позже = выше приоритет) в словарь, плюс то, что вернул плагин в Command.env.
  const envOverlay = existsSync(envFilePath(orch, project, slug)) ? envFilePath(orch, project, slug) : null;
  const hasWtree = slug !== BASE_SLUG && existsSync(resolve(dir, ".env.worktree"));
  const layered = await mergeEnvFiles([
    resolve(projectDir(orch, project, projectsDir), ".env"),
    ...(hasWtree ? [resolve(dir, ".env.worktree")] : []),
    ...(envOverlay ? [envOverlay] : []),
  ]);
  return { argv: ["sh", "-c", inner], env: { PORT: String(args.port), ...layered, ...(cmd.env ?? {}) } };
}

/**
 * `wt run` (foreground, host). Те же host-args, что и `start`, но stdio наследуется и
 * процесс не отвязывается (Ctrl-C завершает). Без runfile/build-lock. Паритет cmd_run.
 * dockerized → кидает (host node_modules в томе; используй `wt start` + `wt logs -f`).
 */
export async function runForeground(
  orch: string,
  project: string,
  slug: string,
  opts: StartOptions = {},
): Promise<number> {
  const config = await resolveProjectConfig(orch, project);
  if (config.docker?.image)
    throw new Error(`${project} — dockerized: foreground недоступен, используй: wt start ${project} ${slug} && wt logs ${project} ${slug} -f`);
  const projectsDir = await resolveProjectsDir(orch);
  const isBase = slug === BASE_SLUG;
  const dir = isBase ? projectDir(orch, project, projectsDir) : worktreeDir(orch, project, slug);
  if (!existsSync(dir)) throw new Error(`нет worktree: ${project}/${slug} (создай: wt new ${project} ${slug})`);
  if (!isBase) {
    await regenerateWorktreeEnvPreserving(orch, project, await gitBranch(dir), dir);
  }
  if (opts.link) await applyLinks(orch, project, slug, opts.linkSlug ?? slug, opts.link === "all" ? undefined : opts.link);
  const plugin = await loadPlugin(config.plugin);
  const port = isBase ? (await resolveBasePort(projectDir(orch, project, projectsDir))) ?? 0 : (await readWorktreePort(dir)) ?? 0;
  const branch = await gitBranch(dir);
  await ensureHostDeps(dir, plugin.install({ orch, project, slug, branch, projectDir: projectDir(orch, project, projectsDir), worktreeDir: dir, config }).argv);
  const { argv, env } = await buildHostDevArgs({ orch, project, slug, dir, branch, port, plugin, config, projectsDir });
  const proc = Bun.spawn(argv, { cwd: dir, env: env ? { ...process.env, ...env } : process.env, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return await proc.exited;
}

async function startHost(
  orch: string,
  project: string,
  slug: string,
  dir: string,
  port: number,
  branch: string,
  probes: AliveProbes,
  projectsDir: string,
): Promise<StartResult> {
  const config = await resolveProjectConfig(orch, project);
  const plugin = await loadPlugin(config.plugin);
  await ensureHostDeps(dir, plugin.install({ orch, project, slug, branch, projectDir: projectDir(orch, project, projectsDir), worktreeDir: dir, config }).argv);
  const { argv: args, env } = await buildHostDevArgs({ orch, project, slug, dir, branch, port, plugin, config, projectsDir });

  await acquireBuildLock(orch, probes);
  try {
    const pid = spawnDetached(args[0]!, args.slice(1), dir, logFilePath(orch, project, slug), env);
    await writeFile(runFilePath(orch, project, slug), formatRunState({ pid, port, branch, started: Math.floor(Date.now() / 1000), project, slug, pgroup: true }));
    const portUp = await waitPortUp(port, { pid, probes });
    return { project, slug, port, pid, container: null, branch, portUp };
  } finally {
    await releaseBuildLock(orch);
  }
}

async function startDockerized(
  orch: string,
  project: string,
  slug: string,
  dir: string,
  port: number,
  branch: string,
  projectsDir: string,
): Promise<StartResult> {
  const container = containerName(project, slug);
  const config = await resolveProjectConfig(orch, project);
  const plugin = await loadPlugin(config.plugin);
  const dh = await devHost();
  const host = dh ?? "host.docker.internal";
  // Снять предыдущий контейнер (в т.ч. залипший Exited) ОБЯЗАТЕЛЬНО: иначе docker run
  // ниже упадёт с 125 «name is already in use», и без этой проверки причина не видна.
  await dockerRemove([container]);

  // dockerSpec капчится один раз ДО рендера env: meteor.docker() не читает extraPorts,
  // поэтому ctx с extraPorts:{} даёт те же mounts/addHosts/env/envLineFilter; реальные
  // extraPorts вычисляются ниже из merged env и используются только в devCommand/buildDockerRunArgs.
  const specCtx = buildInstanceCtx({
    orch, project, slug, dir, branch, config,
    port, offset: 0, container, mode: "docker", settingsPath: null, extraPorts: {}, projectsDir,
  });
  const dockerSpec = plugin.docker?.(specCtx) ?? { mounts: [] };

  // Установка зависимостей — после dockerSpec: и раскладка томов, и сама команда берутся
  // у плагина (meteor → `meteor npm install` + meteor-тома, node → `npm install` без них).
  await ensureDeps(dir, container, config.docker!.image, dockerSpec.mounts, plugin.install(specCtx).argv);

  const envFile = await renderEnvFile(orch, project, slug, host, dockerSpec.envLineFilter, projectsDir);
  const settingsMount = await renderDockerSettings(orch, project, slug, host, projectsDir);

  // Доп-порты (generic): для каждого spec берём env-override из merged env, иначе
  // dockerized-индексированную базу. offset=0 (значение уже включает offset в .env.worktree).
  const dockerized = await resolveDockerizedProjects(orch);
  const extraPorts: Record<string, number> = {};
  for (const spec of plugin.extraPorts ?? []) {
    const fromEnv = spec.envKey ? await readEnvValue(envFile, spec.envKey) : null;
    extraPorts[spec.name] = fromEnv
      ? Number(fromEnv)
      : await resolveAuxBasePort(projectDir(orch, project, projectsDir), project, spec, dockerized);
  }

  const ctx = buildInstanceCtx({
    orch, project, slug, dir, branch, config,
    port, offset: 0, container, mode: "docker",
    settingsPath: settingsMount ? ".wt-settings.json" : null,
    extraPorts, projectsDir,
  });
  // add-hosts: статические из плагина, затем динамический dev-host (порядок текущего кода).
  const addHosts = [...(dockerSpec.addHosts ?? []), ...(dh ? [`${dh}:host-gateway`] : [])];
  const innerCmd = plugin.devCommand(ctx).argv.join(" ");
  // База (slug "base") без .env.worktree → инжектим plugin.envLines (HMR) как `-e`.
  const dockerEnv = baseCheckoutDockerEnv(slug, dockerSpec.env, plugin.envLines?.(ctx) ?? []);
  const args = buildDockerRunArgs({
    container, port, envFile, extraPorts,
    mounts: dockerSpec.mounts, addHosts, innerCmd, image: config.docker!.image, settingsMount,
    dockerEnv,
  });
  await shInherit(["docker", ...args], {
    125: `docker не смог создать контейнер ${container}. Если имя занято — сними вручную: docker rm -f ${container}`,
  });
  await writeFile(runFilePath(orch, project, slug), formatRunState({ container, port, branch, started: Math.floor(Date.now() / 1000), project, slug }));
  const portUp = await waitPortUp(port, {});
  return { project, slug, port, pid: null, container, branch, portUp };
}
