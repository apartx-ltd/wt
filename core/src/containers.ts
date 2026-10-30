/** Имя dev-контейнера. Префикс wtdev- не конфликтует с compose-именами apartx-*. */
export const containerName = (p: string, slug: string): string => `wtdev-${p}-${slug}`;

export interface DockerResult {
  code: number;
  /** Единственный источник причины отказа — гасить его нельзя. */
  stderr: string;
  /** Нужен только читающим командам (ps); rm его не смотрит. */
  stdout?: string;
}

/** Запуск `docker <argv…>`; инъектируется в тестах вместо реального демона. */
export type DockerExec = (argv: string[]) => Promise<DockerResult>;

export const dockerExec: DockerExec = async (argv) => {
  const proc = Bun.spawn(["docker", ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stderr: stderr.trim(), stdout };
};

const dockerFail = (argv: string[], r: DockerResult): Error =>
  new Error(`docker ${argv.join(" ")} → код ${r.code}${r.stderr ? `: ${r.stderr}` : ""}`);

/**
 * `docker ps <argv…>` построчно. Кидает при ненулевом коде: молчаливый пустой список
 * неотличим от «не смог спросить демона» и превращается в ложное «контейнеров нет».
 */
export async function dockerPs(argv: string[], exec: DockerExec = dockerExec): Promise<string[]> {
  const full = ["ps", ...argv];
  const r = await exec(full);
  if (r.code !== 0) throw dockerFail(full, r);
  const out = (r.stdout ?? "").trim();
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * Удалось ли `docker rm`. Код 0 — да (современный docker так выходит и на «нет такого
 * контейнера», просто пишет об этом в stderr). Ненулевой код с «No such container» —
 * тоже успех (старый docker; цель достигнута — контейнера нет). Всё прочее —
 * настоящий отказ (демон недоступен, нет прав, контейнер не снимается).
 */
export function isDockerRemoveOk(r: DockerResult): boolean {
  if (r.code === 0) return true;
  return /no such container/i.test(r.stderr);
}

/**
 * `docker rm -f <ids…>`; кидает с текстом stderr от docker, если контейнер остался.
 * Молчаливое проглатывание кода возврата здесь однажды привело к тому, что `wt stop`
 * рапортовал успех на неудалённом контейнере, а следующий `wt start` падал с 125.
 */
export async function dockerRemove(ids: string[], exec: DockerExec = dockerExec): Promise<void> {
  if (!ids.length) return;
  const argv = ["rm", "-f", ...ids];
  const r = await exec(argv);
  if (isDockerRemoveOk(r)) return;
  throw dockerFail(argv, r);
}
