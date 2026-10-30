import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

/**
 * Отпечаток зависимостей в корне node_modules (в томе контейнера или в каталоге host-проекта).
 * Пишется после каждой установки; `wt start` сверяет его с текущими файлами пакетов и
 * переустанавливает, если они разошлись. Без него непустой том считался годным навсегда:
 * merge develop / checkout другого коммита в worktree зависимости не трогают, и инстанс
 * тихо работал на старых версиях (svelte 5.56 в кабинете вернул тройной `landlord-main-page`).
 */
export const DEPS_STAMP = ".wt-deps-hash";

/** Файлы, по которым менеджер пакетов решает, что ставить. Отсутствующие пропускаются. */
const DEPS_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"];

/** sha256 по содержимому файлов пакетов каталога (имя входит в хеш — перенос между файлами не совпадёт). */
export async function depsHash(dir: string): Promise<string> {
  const h = createHash("sha256");
  for (const name of DEPS_FILES) {
    const path = resolve(dir, name);
    if (!existsSync(path)) continue;
    h.update(`${name}\0`);
    h.update(await readFile(path));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Содержимое отпечатка: хеши ДО и ПОСЛЕ установки. npm при установке переписывает
 * package-lock.json (дрейф версии npm), а worktree потом часто откатывают
 * `git checkout -- package-lock.json` — оба состояния описывают одни и те же зависимости,
 * и ни одно не должно гонять переустановку на каждом старте.
 */
export function formatDepsStamp(before: string, after: string): string {
  return before === after ? `${after}\n` : `${before}\n${after}\n`;
}

export interface DepsState {
  /** node_modules нет или он пуст (свежий том, `wt slim`). */
  empty: boolean;
  /** содержимое DEPS_STAMP; null — отпечатка нет (том поставлен до появления проверки). */
  stamp: string | null;
}

export type DepsVerdict = "ok" | "empty" | "stale";

/** Пусто → ставим; отпечатка нет или текущий хеш не из него → переустанавливаем. */
export function depsVerdict(state: DepsState, current: string): DepsVerdict {
  if (state.empty) return "empty";
  const known = (state.stamp ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return known.includes(current) ? "ok" : "stale";
}

/** Скрипт пробы тома: первая строка — любой элемент (пусто = том пуст), дальше — отпечаток. */
const PROBE_SCRIPT = `ls -A /nm 2>/dev/null | head -1; cat /nm/${DEPS_STAMP} 2>/dev/null`;

/** Разобрать вывод PROBE_SCRIPT. */
export function parseVolumeProbe(out: string): DepsState {
  const [first = "", ...rest] = out.split("\n");
  const stamp = rest.join("\n").trim();
  return { empty: first.trim() === "", stamp: stamp || null };
}

function staleNotice(where: string): void {
  process.stderr.write(`wt: зависимости ${where} не совпадают с package.json/lock — переустанавливаю\n`);
}

async function shInherit(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`команда завершилась с кодом ${code}: ${cmd.join(" ")}`);
}

/**
 * Установка зависимостей в том node_modules контейнера (`docker run --rm` с томами плагина)
 * и запись отпечатка в тот же том. Общая для `wt new` и `wt start`.
 */
export async function installDockerDeps(
  dir: string,
  container: string,
  image: string,
  mounts: string[],
  installArgv: string[],
): Promise<void> {
  const before = await depsHash(dir);
  // Фолбэк на дефолтную meteor-раскладку: плагин без docker() не описал тома, но
  // сюда приходят только dockerized-проекты — монтируем хотя бы репо.
  const volumes = mounts.length ? mounts : [`${dir}:/opt/app`, `${container}-node_modules:/opt/app/node_modules`];
  await shInherit([
    "docker", "run", "--rm",
    ...volumes.flatMap((m) => ["-v", m]),
    "-w", "/opt/app", image, ...installArgv,
  ]);
  const stamp = formatDepsStamp(before, await depsHash(dir));
  await shInherit([
    "docker", "run", "--rm", "-v", `${container}-node_modules:/nm`, image,
    "sh", "-c", `printf '%s' "$1" > /nm/${DEPS_STAMP}`, "sh", stamp,
  ]);
}

/**
 * Перед стартом dockerized-инстанса: пустой том — установка; отпечаток не сходится с
 * текущими файлами пакетов — переустановка. Тома и команда приходят от плагина
 * (`docker().mounts` / `install().argv`). Паритет ensure_deps + проверка устаревания.
 */
export async function ensureDeps(
  dir: string,
  container: string,
  image: string,
  mounts: string[],
  installArgv: string[],
): Promise<void> {
  const probe = Bun.spawn(
    ["docker", "run", "--rm", "-v", `${container}-node_modules:/nm`, image, "sh", "-c", PROBE_SCRIPT],
    { stdout: "pipe", stderr: "ignore" },
  );
  const state = parseVolumeProbe(await new Response(probe.stdout).text());
  await probe.exited;
  const verdict = depsVerdict(state, await depsHash(dir));
  if (verdict === "ok") return;
  if (verdict === "stale") staleNotice(`${container}-node_modules`);
  await installDockerDeps(dir, container, image, mounts, installArgv);
}

/** Host-установка в каталоге worktree + отпечаток в его node_modules. */
export async function installHostDeps(dir: string, installArgv: string[]): Promise<void> {
  const before = await depsHash(dir);
  await shInherit(installArgv, dir);
  await mkdir(resolve(dir, "node_modules"), { recursive: true });
  await writeFile(resolve(dir, "node_modules", DEPS_STAMP), formatDepsStamp(before, await depsHash(dir)));
}

/** Host-аналог ensureDeps: нет node_modules (снёс `wt slim`) или он устарел — install плагина. */
export async function ensureHostDeps(dir: string, installArgv: string[]): Promise<void> {
  const nm = resolve(dir, "node_modules");
  const stampPath = resolve(nm, DEPS_STAMP);
  const state: DepsState = {
    empty: !existsSync(nm),
    stamp: existsSync(stampPath) ? await readFile(stampPath, "utf8") : null,
  };
  const verdict = depsVerdict(state, await depsHash(dir));
  if (verdict === "ok") return;
  if (verdict === "stale") staleNotice(nm);
  await installHostDeps(dir, installArgv);
}
