/** Dev container name. The wtdev- prefix keeps wt's containers apart from the workspace's own compose services. */
export const containerName = (p: string, slug: string): string => `wtdev-${p}-${slug}`;

export interface DockerResult {
  code: number;
  /** The only source of the failure reason — it must never be swallowed. */
  stderr: string;
  /** Only needed by read commands (ps); rm does not look at it. */
  stdout?: string;
}

/** Runs `docker <argv…>`; injected in tests in place of the real daemon. */
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
  new Error(`docker ${argv.join(" ")} → exit code ${r.code}${r.stderr ? `: ${r.stderr}` : ""}`);

/**
 * `docker ps <argv…>` line by line. Throws on a non-zero exit code: a silent empty list
 * is indistinguishable from "could not ask the daemon" and turns into a false "no containers".
 */
export async function dockerPs(argv: string[], exec: DockerExec = dockerExec): Promise<string[]> {
  const full = ["ps", ...argv];
  const r = await exec(full);
  if (r.code !== 0) throw dockerFail(full, r);
  const out = (r.stdout ?? "").trim();
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * Whether `docker rm` succeeded. Exit code 0 — yes (modern docker exits this way even on "no such
 * container", it just reports it on stderr). A non-zero code with "No such container" is
 * also a success (older docker; the goal is reached — the container is gone). Anything else
 * is a real failure (daemon unreachable, no permission, the container cannot be removed).
 */
export function isDockerRemoveOk(r: DockerResult): boolean {
  if (r.code === 0) return true;
  return /no such container/i.test(r.stderr);
}

/**
 * `docker rm -f <ids…>`; throws with docker's stderr text if the container is still there.
 * Silently swallowing the exit code here once made `wt stop` report success for a
 * container that was never removed, and the next `wt start` then failed with 125.
 */
export async function dockerRemove(ids: string[], exec: DockerExec = dockerExec): Promise<void> {
  if (!ids.length) return;
  const argv = ["rm", "-f", ...ids];
  const r = await exec(argv);
  if (isDockerRemoveOk(r)) return;
  throw dockerFail(argv, r);
}
