import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PLUGIN_API_VERSION, type StackPlugin } from "#core/plugin";

/**
 * True if `<worktree>/.cargo/config.toml` (or the extension-less `.cargo/config`, which cargo
 * still reads) defines a `dev` alias under `[alias]`. A line-level scan is enough: alias names
 * are bare keys at the start of a line inside that table, and anything fancier (dotted keys,
 * inline tables) is not how aliases are written.
 */
export function hasDevAlias(worktreeDir: string): boolean {
  for (const name of ["config.toml", "config"]) {
    const path = resolve(worktreeDir, ".cargo", name);
    if (!existsSync(path)) continue;
    let inAlias = false;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[")) inAlias = /^\[\s*alias\s*\]/.test(line);
      else if (inAlias && /^dev\s*=/.test(line)) return true;
    }
  }
  return false;
}

/**
 * Rust (cargo) plugin: `cargo fetch` / `cargo run`, with `target/` as the restorable artifact.
 *
 * The port is not passed on the command line: a Rust binary has no universal `--port`, and an
 * unknown flag would make a clap-parsed binary exit. The core puts the resolved `PORT` into the
 * instance environment in both host and docker mode, so the project reads `PORT` — the
 * twelve-factor convention — and lets it override the port in its own config.
 *
 * Project-specific flags live in cargo's own config, not in wt.config.ts: a `dev` alias in
 * `.cargo/config.toml` (`dev = "run --features dev"`, `dev = "watch -x run"`, a `--bin` …) is
 * run as `cargo dev` instead of `cargo run` — the counterpart of node's `dev` script.
 *
 * `docker()` for projects with `docker: {image}` (an image with the Rust toolchain, e.g.
 * `rust:1-slim`): the worktree at /opt/app, `target` in a named volume per worktree (host
 * build artifacts do not match the Linux container), and the cargo registry and git caches in
 * volumes shared by every instance, so crates are downloaded once. The binary has to bind an
 * external interface (0.0.0.0) inside the container — that is the project's concern.
 */
export const rustPlugin: StackPlugin = {
  name: "rust",
  apiVersion: PLUGIN_API_VERSION,
  envInjection: "inline",
  install: () => ({ argv: ["cargo", "fetch"] }),
  deps: { dir: "target", files: ["Cargo.toml", "Cargo.lock"] },
  artifactDirs: ["target"],
  devCommand: (ctx) => ({ argv: ["cargo", hasDevAlias(ctx.worktreeDir) ? "dev" : "run"] }),
  docker: (ctx) => ({
    mounts: [
      `${ctx.worktreeDir}:/opt/app`,
      `${ctx.container}-target:/opt/app/target`,
      "cargo_registry:/usr/local/cargo/registry",
      "cargo_git:/usr/local/cargo/git",
    ],
    addHosts: ["host.docker.internal:host-gateway"],
    ownedVolumes: [`${ctx.container}-target`],
  }),
};

export default rustPlugin;
