// Where a project's per-worktree docker volumes live: docker named volumes (the default) or
// directories under the workspace (`docker.storage: "dir"`), so the artifacts are visible on
// the host, measured by `wt slim`, and gone with a plain `rm -rf` when docker forgets them.
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

export type DockerStorage = "volume" | "dir";

/** Default `docker.storageDir`, relative to the workspace root. */
export const DEFAULT_STORAGE_DIR = "var/volumes";

/** Host directory standing in for volume `volume`: `<storageDir>/<volume>`, `storageDir` relative to the workspace unless absolute. */
export function volumeDir(orch: string, volume: string, storageDir: string = DEFAULT_STORAGE_DIR): string {
  return resolve(orch, storageDir, volume);
}

/** The `-v` source for an owned volume: its name in volume mode, its directory in dir mode. */
export function storageSource(orch: string, volume: string, storage: DockerStorage, storageDir?: string): string {
  return storage === "dir" ? volumeDir(orch, volume, storageDir) : volume;
}

/**
 * In dir mode, rewrite the mounts whose source is one of the instance's `owned` volumes to the
 * volume's directory; every other mount (the worktree bind, shared caches like `cargo_registry`,
 * the project's own `docker.mounts`) is left as is. In volume mode the mounts are returned unchanged.
 */
export function applyStorage(mounts: string[], owned: string[], storage: DockerStorage, orch: string, storageDir?: string): string[] {
  if (storage !== "dir") return mounts;
  const own = new Set(owned);
  return mounts.map((m) => {
    const i = m.indexOf(":");
    const src = i > 0 ? m.slice(0, i) : m;
    return own.has(src) ? volumeDir(orch, src, storageDir) + m.slice(i) : m;
  });
}

/** In dir mode, create the directory of every owned volume (docker would create a missing bind source itself, but as root on Linux). */
export async function ensureVolumeDirs(orch: string, owned: string[], storage: DockerStorage, storageDir?: string): Promise<void> {
  if (storage !== "dir") return;
  for (const v of owned) await mkdir(volumeDir(orch, v, storageDir), { recursive: true });
}
