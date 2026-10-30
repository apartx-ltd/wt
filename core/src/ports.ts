import { resolve } from "node:path";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import type { ExtraPortSpec } from "./plugin";

/** Port offset step between worktrees (worktree-env.sh STEP=10). */
export const STEP = 10;

/**
 * Ports that must never be handed to a worktree. On macOS, 5000 and 7000 are taken by the system
 * ControlCenter (the AirPlay receiver) — on IPv4 and IPv6 alike. `docker run -p` does not
 * fail and `docker port` reports the port as published, but connections never reach the
 * container: the request is answered by `Server: AirTunes/…` with a 403. The instance is silently
 * unreachable both from the host and from a neighboring container via host.docker.internal, while
 * `wt start --link` has already written that address into the consumer.
 *
 * The list is static rather than "check whether something listens on the port": allocation has to be
 * deterministic and repeatable for a branch, otherwise the offset would drift with the random state
 * of the machine at the moment of the call.
 */
export const BLOCKED_PORTS = [5000, 7000];

export const isBlockedPort = (port: number): boolean => BLOCKED_PORTS.includes(port);

export interface LedgerRow {
  project: string;
  branch: string;
  offset: number;
}

/** The first `^<key>=` value from an env file, with quotes/whitespace stripped; null if absent. */
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

/** The first `^PORT=` value from a file, with quotes/whitespace stripped; null if absent. */
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
 * The project's base PORT: from `PORT=` in `<projectDir>/.env`, otherwise from package.json
 * (`PORT=NN` | `--port NN` | `--port=NN` | `-p NN`, first number). Parity with
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
 * Deterministic base aux port of a project: `spec.basePort` + the project's stable index
 * within the dockerized set. Unique within the set; limited to 10 buckets (worktree offsets
 * are multiples of STEP=10 → a difference <10 rules out base↔worktree collisions). The stack's name/number (hmr/8085)
 * comes in `spec` from the plugin and is not hardcoded here.
 */
export function deterministicAuxBasePort(project: string, basePort: number, dockerized: string[]): number {
  const sorted = [...dockerized].sort();
  const idx = sorted.indexOf(project);
  if (idx === -1) {
    throw new Error(
      `deterministicAuxBasePort: ${project} is not among the config's dockerized projects; ` +
        `set the aux port's env override in the project's .env`,
    );
  }
  if (idx >= 10) {
    throw new Error(
      `deterministicAuxBasePort: ${project} got index ${idx} >= 10; ` +
        `set the aux port's env override in the project's .env`,
    );
  }
  return basePort + idx;
}

/** Aux port base: the env override from `<projectDir>/.env` (spec.envKey), otherwise deterministic. */
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

/** Parse ledger text (`project\tbranch\toffset`). Empty/short lines are ignored. */
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
 * Offset for (project, branch): the existing one if any; otherwise the smallest `n*STEP`
 * (n≥1) not present among ALL offsets in the ledger. Parity with worktree-env.sh.
 *
 * `basePort` enables the BLOCKED_PORTS check: a port taken by the system is handed neither to
 * a new branch nor to a known one — a branch with a "blind" port moves to the next free one
 * (its ledger row has to be rewritten, see upsertLedger). Without `basePort` the behavior
 * is unchanged.
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

/** PORT from the worktree directory's `.env.worktree`; null if the file/key is missing. */
export async function readWorktreePort(worktreeDir: string): Promise<number | null> {
  return grepPort(resolve(worktreeDir, ".env.worktree"));
}

const ledgerPath = (orch: string) => resolve(orch, "var", "worktree-ports.tsv");

/** Read the ledger from `<orch>/var/worktree-ports.tsv`; [] if the file is missing. */
export async function readLedger(orch: string): Promise<LedgerRow[]> {
  const f = Bun.file(ledgerPath(orch));
  if (!(await f.exists())) return [];
  return parseLedger(await f.text());
}

/** Append an offset row to the ledger (creating var/ if missing). No lock — parity with worktree-env.sh. */
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
 * Write the offset for (project, branch), replacing the existing row. Unlike
 * appendLedger it rewrites the whole file, so it is called ONLY when the branch actually
 * moves (its port hit BLOCKED_PORTS): a duplicate row would not do — allocateOffset
 * takes the first match and would return the old, unreachable port.
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
