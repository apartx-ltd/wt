import { resolve } from "node:path";

/** Paths of wt artifacts (parity with RUN_DIR/SETTINGS_DIR/ENV_DIR and the helpers in scripts/wt-legacy). */
export const runDir = (orch: string): string => resolve(orch, "var", "run");
export const runFilePath = (orch: string, p: string, slug: string): string => resolve(runDir(orch), `${p}-${slug}.run`);
export const logFilePath = (orch: string, p: string, slug: string): string => resolve(runDir(orch), `${p}-${slug}.log`);
export const mergedEnvPath = (orch: string, p: string, slug: string): string => resolve(runDir(orch), `${p}-${slug}.env.merged`);
export const dockerSettingsPath = (orch: string, p: string, slug: string): string =>
  resolve(runDir(orch), `${p}-${slug}.settings.docker.json`);
/** patched settings of a link (var/settings/<p>-<slug>.json). */
export const ovrFilePath = (orch: string, p: string, slug: string): string => resolve(orch, "var", "settings", `${p}-${slug}.json`);
/** env layer of a link (var/env/<p>-<slug>.env). */
export const envFilePath = (orch: string, p: string, slug: string): string => resolve(orch, "var", "env", `${p}-${slug}.env`);
export const worktreeDir = (orch: string, p: string, slug: string): string => resolve(orch, "worktrees", p, slug);
export const projectDir = (orch: string, p: string, projectsDir = "projects"): string =>
  projectsDir === "." ? resolve(orch) : resolve(orch, projectsDir, p);
