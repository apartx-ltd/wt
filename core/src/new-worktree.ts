import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile, appendFile, readFile, unlink, rm } from "node:fs/promises";
import { resolveBasePort, resolveAuxBasePort, readLedger, allocateOffset, appendLedger, upsertLedger, readEnvValue } from "./ports";
import { generateEnvWorktree, branchDbSuffix } from "./env-worktree";
import { containerName } from "./containers";
import { loadPlugin, type EnvCtx, type InstanceCtx } from "./plugin";
import { loadConfig, resolveProjectConfig, resolveDockerizedProjects, resolveProjectsDir } from "./config";
import { stopInstance } from "./run";
import { installDockerDeps, installHostDeps } from "./deps";
import {
  projectDir,
  worktreeDir,
  mergedEnvPath,
  dockerSettingsPath,
  ovrFilePath,
  envFilePath,
} from "./paths";

/** Базовый slug = базовый checkout (projects/<p>), зарезервирован — не worktree. */
export const BASE_SLUG = "base";

/** Запустить команду со стримингом stdio; кинуть при ненулевом коде. */
async function sh(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`команда завершилась с кодом ${code}: ${cmd.join(" ")}`);
}

/** true если команда завершилась с кодом 0 (вывод подавлен). */
async function shOk(cmd: string[], cwd?: string): Promise<boolean> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

/** Добавить `.env.worktree` в `<git-common-dir>/info/exclude` (паритет worktree-env.sh). */
async function addInfoExclude(worktreeDir: string): Promise<void> {
  const proc = Bun.spawn(["git", "-C", worktreeDir, "rev-parse", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!out) return;
  const excl = resolve(resolve(worktreeDir, out), "info", "exclude");
  if (!existsSync(excl)) return;
  const cur = await readFile(excl, "utf8");
  if (!cur.split("\n").includes(".env.worktree")) await appendFile(excl, ".env.worktree\n");
}

export interface ComputedWorktreeEnv {
  offset: number;
  port: number;
  content: string;
  /** true если ветки ещё нет в ledger (offset только что выделен, не записан). */
  isNew: boolean;
  /** true если ветка была в ledger, но её порт занят системой и она переехала на новый offset. */
  reallocated: boolean;
}

/**
 * Рассчитать `.env.worktree` для (project, branch) БЕЗ записи: базовый порт +
 * offset (существующий из ledger или следующий свободный) + содержимое. Для уже
 * известной ветки полностью read-only (offset из ledger) — годится для сверки с
 * живым worktree. `isolatedDb` добавляет MONGO_URL из base `.env` проекта.
 */
export async function computeWorktreeEnv(
  orch: string,
  project: string,
  branch: string,
  opts: { isolatedDb?: boolean } = {},
): Promise<ComputedWorktreeEnv> {
  const pdir = projectDir(orch, project, await resolveProjectsDir(orch));
  const basePort = await resolveBasePort(pdir);
  if (basePort === null) throw new Error(`не нашёл PORT в .env/package.json проекта ${project}`);
  const config = await resolveProjectConfig(orch, project);
  const baseRootUrl = (await readEnvValue(resolve(pdir, ".env"), "ROOT_URL")) ?? `http://localhost:${basePort}`;

  const ledger = await readLedger(orch);
  const existingRow = ledger.find((r) => r.project === project && r.branch === branch);
  const isNew = !existingRow;
  const offset = allocateOffset(ledger, project, branch, basePort);
  // Ветка уже была в ledger, но её порт занят системой (BLOCKED_PORTS) — переезжаем.
  const reallocated = !!existingRow && existingRow.offset !== offset;

  let baseMongo: string | undefined;
  if (opts.isolatedDb) {
    const m = await readEnvValue(resolve(pdir, ".env"), "MONGO_URL");
    if (!m) throw new Error(`нет MONGO_URL= в .env проекта ${project} для --isolated-db`);
    baseMongo = m;
  }

  // Доп-порты — из plugin.extraPorts (generic). Аллоцируем порт только если проект
  // dockerized ИЛИ env-override доп-порта задан явно в .env (host-mode без него — пропуск,
  // deterministicAuxBasePort кинул бы вне dockerized-набора). Паритет с прежним hmr-кейсом.
  const plugin = await loadPlugin(config.plugin);
  const dockerized = await resolveDockerizedProjects(orch);
  const extraPorts: Record<string, number> = {};
  for (const spec of plugin.extraPorts ?? []) {
    const explicit = spec.envKey ? await readEnvValue(resolve(pdir, ".env"), spec.envKey) : null;
    if (config.docker?.image || explicit !== null) {
      extraPorts[spec.name] = (await resolveAuxBasePort(pdir, project, spec, dockerized)) + offset;
    }
  }
  const envCtx: EnvCtx = {
    orch, project, slug: branch, branch,
    projectDir: pdir, worktreeDir: pdir, config,
    port: basePort + offset, offset, container: "", mode: "docker",
    settingsPath: null, extraPorts,
  };
  const extraEnvLines = plugin.envLines ? plugin.envLines(envCtx) : [];
  // Tail-строки (.env.worktree после ROOT_URL) даёт плагин (meteor: MONGO_OPLOG_URL=,
  // MONTI_*). Изолированный <urlEnvKey>= — через тот же isolatedDb-контракт, что и --seed.
  const tailLines = [...(plugin.worktreeEnvTail?.(envCtx) ?? [])];
  if (opts.isolatedDb && plugin.isolatedDb && baseMongo) {
    const { urlEnvKey, deriveUrl } = plugin.isolatedDb;
    tailLines.push(`${urlEnvKey}=${deriveUrl(baseMongo, branchDbSuffix(branch))}`);
  }
  // Проектный env из wt.config.ts — wt-managed ключи, как строки плагина. Base-checkout их не
  // получает (у него нет .env.worktree): это и нужно для неймспейсов вроде CHATS_QUEUE_NS.
  const vars: Record<string, string> = {
    port: String(basePort + offset),
    offset: String(offset),
    branchSuffix: branchDbSuffix(branch),
  };
  for (const [key, template] of Object.entries(config.env ?? {})) {
    tailLines.push(`${key}=${template.replace(/\$\{(\w+)\}/g, (m, name) => vars[name] ?? m)}`);
  }
  const content = generateEnvWorktree({ project, branch, offset, basePort, extraEnvLines, baseRootUrl, tailLines });
  return { offset, port: basePort + offset, content, isNew, reallocated };
}

/**
 * Записать `.env.worktree` в каталог worktree и (если ветка новая) дописать offset
 * в ledger. Возвращает рассчитанные значения. Паритет с worktree-env.sh.
 */
export async function commitWorktreeEnv(
  orch: string,
  project: string,
  branch: string,
  worktreeDir: string,
  opts: { isolatedDb?: boolean } = {},
): Promise<ComputedWorktreeEnv> {
  const computed = await computeWorktreeEnv(orch, project, branch, opts);
  await mkdir(worktreeDir, { recursive: true });
  await writeFile(resolve(worktreeDir, ".env.worktree"), computed.content);
  if (computed.isNew) await appendLedger(orch, project, branch, computed.offset);
  else if (computed.reallocated) await upsertLedger(orch, project, branch, computed.offset);
  return computed;
}

/** Парсинг `.env.worktree` в Map<KEY, полная-строка> (комментарии/пустые игнор). */
function envLinesByKey(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const mm = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (mm) m.set(mm[1]!, line);
  }
  return m;
}

/**
 * Перегенерировать `.env.worktree`, СОХРАНИВ непра́вляемые ключи. wt-managed ключи
 * (PORT/ROOT_URL/plugin envLines/worktreeEnvTail/isolated urlEnvKey) переписываются на
 * текущие детерминированные значения; всё прочее (ручные добавления) сохраняется дословно.
 * Isolated-режим выводится из НАЛИЧИЯ urlEnvKey в текущем файле — регенерация НИКОГДА не
 * переключает isolated↔shared. Идемпотентна на канонично-сгенерированном файле.
 */
export async function regenerateWorktreeEnvPreserving(
  orch: string,
  project: string,
  branch: string,
  worktreeDir: string,
): Promise<ComputedWorktreeEnv> {
  const path = resolve(worktreeDir, ".env.worktree");
  const existing = existsSync(path) ? envLinesByKey(await readFile(path, "utf8")) : new Map<string, string>();

  const config = await resolveProjectConfig(orch, project);
  const plugin = await loadPlugin(config.plugin);
  const urlKey = plugin.isolatedDb?.urlEnvKey;
  const isolatedDb = urlKey ? existing.has(urlKey) : false;

  const computed = await computeWorktreeEnv(orch, project, branch, { isolatedDb });
  const managed = new Set(envLinesByKey(computed.content).keys());

  const preserved: string[] = [];
  for (const [k, line] of existing) if (!managed.has(k)) preserved.push(line);

  const content = preserved.length
    ? computed.content.replace(/\n$/, "\n") + preserved.join("\n") + "\n"
    : computed.content;

  await mkdir(worktreeDir, { recursive: true });
  await writeFile(path, content);
  if (computed.isNew) await appendLedger(orch, project, branch, computed.offset);
  else if (computed.reallocated) await upsertLedger(orch, project, branch, computed.offset);
  return computed;
}

export interface CreateWorktreeOpts {
  isolatedDb?: boolean;
  seed?: boolean;
}
export interface CreateWorktreeResult {
  dir: string;
  branch: string;
  port: number;
  offset: number;
}

/**
 * Полный `wt new`: git worktree add (+branch) → submodule init → `meteor npm install`
 * (docker для dockerized-проектов, иначе host) → запись `.env.worktree`+ledger → info/exclude.
 * Паритет с cmd_new (scripts/wt-legacy). `--seed` делегируется плагину
 * (`plugin.isolatedDb.seed`, dump/restore исполняет ядро через `sh`).
 */
export async function createWorktree(
  orch: string,
  project: string,
  slug: string,
  opts: CreateWorktreeOpts = {},
): Promise<CreateWorktreeResult> {
  if (slug === BASE_SLUG)
    throw new Error(`slug '${BASE_SLUG}' зарезервирован под базовый checkout — нельзя создать как worktree`);
  if (opts.seed && !opts.isolatedDb) throw new Error("--seed требует --isolated-db");

  const pdir = projectDir(orch, project, await resolveProjectsDir(orch));
  if (!existsSync(resolve(pdir, ".git"))) throw new Error(`нет проекта: ${project} (ожидал ${pdir})`);
  const dir = resolve(orch, "worktrees", project, slug);
  if (existsSync(dir)) throw new Error(`worktree уже существует: ${dir}`);

  // Имя ветки и точка форка — из config.branches (M2.5). Префикс правит slug↔branch,
  // base — стартовая точка новой ветки (apartx: "develop"), а не текущий HEAD базового
  // checkout'а. base undefined (конфига нет) ⇒ фоллбэк на HEAD.
  const cfg = await loadConfig(orch, basename(orch)).catch(() => null);
  const prefix = cfg?.branches.prefix ?? "feature/";
  const base = cfg?.branches.base;
  const branch = `${prefix}${slug}`;
  const hasBranch = await shOk(["git", "-C", pdir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  await sh(
    hasBranch
      ? ["git", "-C", pdir, "worktree", "add", dir, branch]
      : base
        ? ["git", "-C", pdir, "worktree", "add", dir, "-b", branch, base]
        : ["git", "-C", pdir, "worktree", "add", dir, "-b", branch],
  );

  // git worktree add НЕ инитит сабмодули — без них Meteor падает на local packages
  if (existsSync(resolve(dir, ".gitmodules"))) {
    await sh(["git", "-C", dir, "submodule", "update", "--init", "--recursive"]);
  }

  const config = await resolveProjectConfig(orch, project);
  const plugin = await loadPlugin(config.plugin);
  const cn = containerName(project, slug);
  // install: плагин описывает команду; ядро исполняет (host — в каталоге worktree,
  // docker — внутри `docker run --rm` с теми же томами/образом, что и при старте).
  const installCtx: InstanceCtx = {
    orch, project, slug, branch,
    projectDir: pdir, worktreeDir: dir, config,
    port: 0, offset: 0, container: cn, mode: config.docker?.image ? "docker" : "host",
    settingsPath: null, extraPorts: {},
  };
  const installArgv = plugin.install(installCtx).argv;
  if (config.docker?.image) {
    await installDockerDeps(dir, cn, config.docker!.image, plugin.docker!(installCtx).mounts, installArgv);
  } else {
    await installHostDeps(dir, installArgv);
  }

  const computed = await commitWorktreeEnv(orch, project, branch, dir, { isolatedDb: opts.isolatedDb });
  await addInfoExclude(dir);

  if (opts.isolatedDb && opts.seed) {
    // Config-driven: ключ БД-URL и derive из plugin.isolatedDb, seed исполняет ядро (sh).
    const iso = plugin.isolatedDb;
    if (!iso?.seed) throw new Error(`plugin ${config.plugin}: нет isolatedDb.seed для --seed`);
    const baseMongo = await readEnvValue(resolve(pdir, ".env"), iso.urlEnvKey);
    if (!baseMongo) throw new Error(`нет ${iso.urlEnvKey} в .env проекта ${project} для --seed`);
    const isoMongo = iso.deriveUrl(baseMongo, branchDbSuffix(branch)); // цель = <db>_<suffix>, НЕ базовая БД
    await iso.seed({
      baseDbUrl: baseMongo,
      isolatedDbUrl: isoMongo,
      run: sh,
    } as any);
  }

  return { dir, branch, port: computed.port, offset: computed.offset };
}

export interface RemoveWorktreeOpts {
  /** также удалить ветку feature/<slug> (git branch -d). */
  dropBranch?: boolean;
}

/**
 * `wt rm <p> <slug>`: остановить инстанс (если запущен) → для dockerized снести
 * per-worktree тома + merged env/settings → убрать run/link-артефакты → `git
 * worktree remove` (force-фоллбэк) + prune → опц. branch -d. Порт за веткой
 * остаётся в ledger (зарезервирован). Паритет cmd_rm.
 */
export async function removeWorktree(
  orch: string,
  project: string,
  slug: string,
  opts: RemoveWorktreeOpts = {},
): Promise<void> {
  if (slug === BASE_SLUG)
    throw new Error(`базовый checkout (slug '${BASE_SLUG}') нельзя удалять через wt rm — это projects/${project}`);
  const pdir = projectDir(orch, project, await resolveProjectsDir(orch));
  if (!existsSync(resolve(pdir, ".git"))) throw new Error(`нет проекта: ${project} (ожидал ${pdir})`);
  const dir = worktreeDir(orch, project, slug);

  await stopInstance(orch, project, slug); // стоп + удаление runfile (no-op если не запущен)

  const config = await resolveProjectConfig(orch, project);
  if (config.docker?.image) {
    const cn = containerName(project, slug);
    await shOk(["docker", "volume", "rm", `${cn}-node_modules`, `${cn}-meteor_local`]);
    await unlink(mergedEnvPath(orch, project, slug)).catch(() => {});
    await unlink(dockerSettingsPath(orch, project, slug)).catch(() => {});
  }
  await unlink(ovrFilePath(orch, project, slug)).catch(() => {});
  await unlink(envFilePath(orch, project, slug)).catch(() => {});

  if (!(await shOk(["git", "-C", pdir, "worktree", "remove", dir]))) {
    await shOk(["git", "-C", pdir, "worktree", "remove", "--force", dir]);
  }
  await shOk(["git", "-C", pdir, "worktree", "prune"]);
  if (opts.dropBranch) {
    const cfg = await loadConfig(orch, basename(orch)).catch(() => null);
    const prefix = cfg?.branches.prefix ?? "feature/";
    await shOk(["git", "-C", pdir, "branch", "-d", `${prefix}${slug}`]);
  }
}
