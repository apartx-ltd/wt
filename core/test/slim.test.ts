import { test, expect, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { classifySlim, collectSlimFacts, findOrphanVolumes, type SlimFacts } from "../src/slim";
import { registerBundledPlugins } from "#plugins";

// collectSlimFacts loads the projects' plugins → the registry has to be populated.
beforeAll(() => registerBundledPlugins());

const base: SlimFacts = {
  running: false,
  dirs: [{ path: "/orch/worktrees/apartx-cabinet/ai-title/node_modules", bytes: 1024 }],
  volumes: ["wtdev-apartx-cabinet-ai-title-node_modules"],
};

test("stopped, has directories and volumes → slim", () => {
  expect(classifySlim(base)).toEqual({ action: "slim", reason: "slim" });
});

test("running → skip running, even with artifacts", () => {
  expect(classifySlim({ ...base, running: true })).toEqual({ action: "skip", reason: "running" });
});

test("volumes only (no host directories) → slim", () => {
  expect(classifySlim({ ...base, dirs: [] })).toEqual({ action: "slim", reason: "slim" });
});

test("host directories only (not dockerized) → slim", () => {
  expect(classifySlim({ ...base, volumes: [] })).toEqual({ action: "slim", reason: "slim" });
});

test("nothing to remove → skip clean", () => {
  expect(classifySlim({ ...base, dirs: [], volumes: [] })).toEqual({ action: "skip", reason: "clean" });
});

test("orphans: wtdev volumes absent from the volumes of existing worktrees and base", () => {
  const owned = new Set([
    "wtdev-apartx-server-base-node_modules",
    "wtdev-apartx-server-ai-tasks-node_modules",
  ]);
  expect(findOrphanVolumes([
    "wtdev-apartx-server-base-node_modules",
    "wtdev-apartx-server-ai-tasks-node_modules",
    "wtdev-apartx-server-property-season-meteor_local",
    "apartx_nats_data",
    "meteor_base",
  ], owned)).toEqual(["wtdev-apartx-server-property-season-meteor_local"]);
});

// --- collectSlimFacts: unlisted repos in a config without defaults.plugin ---

const CONFIG_SRC = resolve(import.meta.dir, "../src/config");

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

async function repo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
}

test("collectSlimFacts: an unlisted repo (no defaults.plugin) keeps its volumes owned, not orphaned", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-slim-unlisted-"));
  try {
    writeFileSync(
      resolve(orch, "wt.config.ts"),
      `import { defineWorkspace } from ${JSON.stringify(CONFIG_SRC)};
export default defineWorkspace({
  projects: { api: { plugin: "@apartx/wt/plugin-node", docker: { image: "node:22" } } },
});
`,
    );
    await repo(resolve(orch, "projects", "api"));
    await repo(resolve(orch, "projects", "docs")); // e.g. a docs/library repo nobody lists
    // A worktree of the unlisted repo exists as well (created before it was unlisted).
    await git(resolve(orch, "projects", "docs"), "worktree", "add", "-q", resolve(orch, "worktrees", "docs", "old"), "-b", "feature/old");

    const volumes = [
      "wtdev-api-base-node_modules", // api base: declared by the node plugin
      "wtdev-docs-base-node_modules", // unlisted repo: owned conservatively
      "wtdev-docs-old-meteor_local", // unlisted repo's worktree: owned conservatively
      "wtdev-gone-x-node_modules", // no such project: a real orphan
    ];
    const plan = await collectSlimFacts(orch, { listVolumes: async () => volumes });
    expect(plan.orphanVolumes).toEqual(["wtdev-gone-x-node_modules"]);
    // the unlisted repo's worktree is not slimmed: its plugin (and so its artifacts) is unknown
    expect(plan.items.map((i) => `${i.project}/${i.slug}`)).not.toContain("docs/old");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});
