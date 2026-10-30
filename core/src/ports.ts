import { resolve } from "node:path";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import type { ExtraPortSpec } from "./plugin";

/** Шаг смещения портов между worktree (worktree-env.sh STEP=10). */
export const STEP = 10;

/**
 * Порты, которые worktree выдавать нельзя. На macOS 5000 и 7000 слушает системный
 * ControlCenter (приёмник AirPlay) — на IPv4 и IPv6 сразу. `docker run -p` при этом
 * не падает и `docker port` рапортует публикацию, но соединения до контейнера не
 * доходят: на запрос отвечает `Server: AirTunes/…` с 403. Инстанс молча недоступен ни
 * с хоста, ни из соседнего контейнера через host.docker.internal, а `wt start --link`
 * успевает прописать потребителю этот адрес.
 *
 * Список статический, а не «проверить, слушает ли кто-то порт»: аллокация обязана быть
 * детерминированной и повторяемой для ветки, иначе offset поедет от случайного состояния
 * машины в момент вызова.
 */
export const BLOCKED_PORTS = [5000, 7000];

export const isBlockedPort = (port: number): boolean => BLOCKED_PORTS.includes(port);

export interface LedgerRow {
  project: string;
  branch: string;
  offset: number;
}

/** Первое `^<key>=` значение из env-файла, со снятыми кавычками/пробелами; null если нет. */
export async function readEnvValue(file: string, key: string): Promise<string | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  const re = new RegExp(`^${key}=(.*)$`);
  for (const line of (await f.text()).split("\n")) {
    const m = re.exec(line);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "").trim();
  }
  return null;
}

/** Первое `^PORT=` значение из файла, со снятыми кавычками/пробелами; null если нет. */
async function grepPort(file: string): Promise<number | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  for (const line of (await f.text()).split("\n")) {
    const m = /^PORT=(.*)$/.exec(line);
    if (m) {
      const v = m[1].trim().replace(/^['"]|['"]$/g, "").trim();
      const n = Number.parseInt(v, 10);
      return Number.isNaN(n) ? null : n;
    }
  }
  return null;
}

/**
 * Базовый PORT проекта: из `<projectDir>/.env` `PORT=`, иначе из package.json
 * (`PORT=NN` | `--port NN` | `--port=NN` | `-p NN`, первое число). Паритет с
 * proj_base_port()/worktree-env.sh.
 */
export async function resolveBasePort(projectDir: string): Promise<number | null> {
  const fromEnv = await grepPort(resolve(projectDir, ".env"));
  if (fromEnv !== null) return fromEnv;
  const pkg = Bun.file(resolve(projectDir, "package.json"));
  if (await pkg.exists()) {
    const m = /PORT=([0-9]+)|--port[ =]([0-9]+)|-p ([0-9]+)/.exec(await pkg.text());
    if (m) {
      const n = Number.parseInt(m[1] ?? m[2] ?? m[3], 10);
      return Number.isNaN(n) ? null : n;
    }
  }
  return null;
}

/**
 * Детерминированный базовый доп-порт проекта: `spec.basePort` + стабильный индекс проекта
 * среди dockerized-набора. Уникален в пределах набора; лимит 10 корзин (offset'ы worktree
 * кратны STEP=10 → разница <10 исключает коллизии base↔worktree). Имя/число стека (hmr/8085)
 * приходит в `spec` от плагина, не зашито здесь.
 */
export function deterministicAuxBasePort(project: string, basePort: number, dockerized: string[]): number {
  const sorted = [...dockerized].sort();
  const idx = sorted.indexOf(project);
  if (idx === -1) {
    throw new Error(
      `deterministicAuxBasePort: ${project} не входит в dockerized-проекты конфига; ` +
        `задайте env-override доп-порта в .env проекта`,
    );
  }
  if (idx >= 10) {
    throw new Error(
      `deterministicAuxBasePort: ${project} получил индекс ${idx} >= 10; ` +
        `задайте env-override доп-порта в .env проекта`,
    );
  }
  return basePort + idx;
}

/** База доп-порта: env-override из `<projectDir>/.env` (spec.envKey), иначе детерминированно. */
export async function resolveAuxBasePort(
  projectDir: string,
  project: string,
  spec: ExtraPortSpec,
  dockerized: string[],
): Promise<number> {
  if (spec.envKey) {
    const v = await readEnvValue(resolve(projectDir, ".env"), spec.envKey);
    if (v !== null) {
      const n = Number.parseInt(v, 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  return deterministicAuxBasePort(project, spec.basePort, dockerized);
}

/** Разбор ledger-текста (`project\tbranch\toffset`). Пустые/короткие строки игнор. */
export function parseLedger(text: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const offset = Number.parseInt(parts[2], 10);
    if (Number.isNaN(offset)) continue;
    rows.push({ project: parts[0], branch: parts[1], offset });
  }
  return rows;
}

/**
 * Offset для (project, branch): существующий если есть; иначе наименьший `n*STEP`
 * (n≥1), которого нет среди ВСЕХ offset’ов ledger. Паритет с worktree-env.sh.
 *
 * `basePort` включает проверку на BLOCKED_PORTS: занятый системой порт не выдаётся ни
 * новой ветке, ни известной — ветка со «слепым» портом переезжает на следующий свободный
 * (её строку в ledger надо переписать, см. upsertLedger). Без `basePort` поведение
 * прежнее.
 */
export function allocateOffset(
  ledger: LedgerRow[],
  project: string,
  branch: string,
  basePort?: number,
): number {
  const blocked = (offset: number) => basePort !== undefined && isBlockedPort(basePort + offset);
  const existing = ledger.find((r) => r.project === project && r.branch === branch);
  if (existing && !blocked(existing.offset)) return existing.offset;
  const taken = new Set(ledger.map((r) => r.offset));
  let n = 1;
  while (taken.has(n * STEP) || blocked(n * STEP)) n++;
  return n * STEP;
}

/** PORT из `.env.worktree` worktree-каталога; null если файла/ключа нет. */
export async function readWorktreePort(worktreeDir: string): Promise<number | null> {
  return grepPort(resolve(worktreeDir, ".env.worktree"));
}

const ledgerPath = (orch: string) => resolve(orch, "var", "worktree-ports.tsv");

/** Прочитать ledger из `<orch>/var/worktree-ports.tsv`; [] если файла нет. */
export async function readLedger(orch: string): Promise<LedgerRow[]> {
  const f = Bun.file(ledgerPath(orch));
  if (!(await f.exists())) return [];
  return parseLedger(await f.text());
}

/** Дописать строку offset в ledger (создав var/ при отсутствии). Без лока — паритет worktree-env.sh. */
export async function appendLedger(
  orch: string,
  project: string,
  branch: string,
  offset: number,
): Promise<void> {
  await mkdir(resolve(orch, "var"), { recursive: true });
  await appendFile(ledgerPath(orch), `${project}\t${branch}\t${offset}\n`);
}

/**
 * Записать offset для (project, branch), заменив существующую строку. В отличие от
 * appendLedger переписывает файл целиком, поэтому зовётся ТОЛЬКО когда ветка реально
 * переезжает (порт попал в BLOCKED_PORTS): дубль строки не годится — allocateOffset
 * берёт первое совпадение и вернул бы прежний, недоступный порт.
 */
export async function upsertLedger(
  orch: string,
  project: string,
  branch: string,
  offset: number,
): Promise<void> {
  const path = ledgerPath(orch);
  const f = Bun.file(path);
  const rows = (await f.exists()) ? parseLedger(await f.text()) : [];
  const idx = rows.findIndex((r) => r.project === project && r.branch === branch);
  if (idx === -1) rows.push({ project, branch, offset });
  else rows[idx] = { project, branch, offset };
  await mkdir(resolve(orch, "var"), { recursive: true });
  await writeFile(path, rows.map((r) => `${r.project}\t${r.branch}\t${r.offset}`).join("\n") + "\n");
}
