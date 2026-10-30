import { resolve } from "node:path";

/** Пути артефактов wt (паритет с RUN_DIR/SETTINGS_DIR/ENV_DIR и хелперами в scripts/wt-legacy). */
export const runDir = (orch: string): string => resolve(orch, "var", "run");
export const runFilePath = (orch: string, p: string, slug: string): string => resolve(runDir(orch), `${p}-${slug}.run`);
export const logFilePath = (orch: string, p: string, slug: string): string => resolve(runDir(orch), `${p}-${slug}.log`);
export const mergedEnvPath = (orch: string, p: string, slug: string): string => resolve(runDir(orch), `${p}-${slug}.env.merged`);
export const dockerSettingsPath = (orch: string, p: string, slug: string): string =>
  resolve(runDir(orch), `${p}-${slug}.settings.docker.json`);
/** патченный settings линка (var/settings/<p>-<slug>.json). */
export const ovrFilePath = (orch: string, p: string, slug: string): string => resolve(orch, "var", "settings", `${p}-${slug}.json`);
/** env-слой линка (var/env/<p>-<slug>.env). */
export const envFilePath = (orch: string, p: string, slug: string): string => resolve(orch, "var", "env", `${p}-${slug}.env`);
export const worktreeDir = (orch: string, p: string, slug: string): string => resolve(orch, "worktrees", p, slug);
export const projectDir = (orch: string, p: string, projectsDir = "projects"): string =>
  projectsDir === "." ? resolve(orch) : resolve(orch, projectsDir, p);
