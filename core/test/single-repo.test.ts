import { test, expect, beforeAll } from "bun:test";
import { registerBundledPlugins } from "#plugins";
import { createWorktree, computeWorktreeEnv } from "../src/new-worktree";
import { listProjects } from "../src/projects";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";

beforeAll(() => registerBundledPlugins());

/**
 * Собрать одноразовый single-repo: git-репо с `wt.config.ts` (`project: { plugin:
 * "@apartx/wt/plugin-node" }`) + минимальное node-приложение. Ни одного apartx-знания —
 * чистый node-проект, по которому wt должен ездить как по любому bare-репо.
 *
 * Дефолтную ветку явно ренеймим в `main` (init.defaultBranch у хоста может быть
 * `master`), чтобы `branches.base: "main"` всегда существовал как ref для форка.
 */
async function makeSingleRepo(): Promise<string> {
  const orch = await mkdtemp(resolve(tmpdir(), "wt-singleproof-"));
  await Bun.spawn(["git", "init", "-q", orch]).exited;
  await Bun.spawn(["git", "-C", orch, "config", "user.email", "t@t"]).exited;
  await Bun.spawn(["git", "-C", orch, "config", "user.name", "t"]).exited;
  await writeFile(
    resolve(orch, "package.json"),
    JSON.stringify({ name: basename(orch), scripts: { dev: "node server.js" } }, null, 2),
  );
  await writeFile(resolve(orch, ".env"), "PORT=5200\nROOT_URL=http://localhost:5200\n");
  await writeFile(
    resolve(orch, "server.js"),
    "require('http').createServer((_,r)=>r.end('ok')).listen(process.env.PORT||5200)\n",
  );
  await writeFile(
    resolve(orch, "wt.config.ts"),
    `import { defineWorkspace } from "${resolve(import.meta.dir, "../src/config")}";\n` +
      `export default defineWorkspace({ title: "myapp", branches: { base: "main", prefix: "feat/" }, project: { plugin: "@apartx/wt/plugin-node" } });\n`,
  );
  await Bun.spawn(["git", "-C", orch, "add", "-A"]).exited;
  await Bun.spawn(["git", "-C", orch, "commit", "-q", "-m", "init"]).exited;
  // детерминизм: гарантируем ветку `main` независимо от init.defaultBranch хоста.
  await Bun.spawn(["git", "-C", orch, "branch", "-M", "main"]).exited;
  return orch;
}

test("single-repo: listProjects returns the repo basename", async () => {
  const orch = await makeSingleRepo();
  try {
    expect(await listProjects(orch)).toEqual([basename(orch)]);
  } finally {
    await rm(orch, { recursive: true, force: true });
  }
});

test("single-repo: computeWorktreeEnv resolves PORT/ROOT_URL from the repo root .env (no apartx knowledge)", async () => {
  const orch = await makeSingleRepo();
  const project = basename(orch);
  try {
    const env = await computeWorktreeEnv(orch, project, "feat/x");
    expect(env.port).toBe(5210); // basePort 5200 + offset 10
    expect(env.content).toContain("PORT=5210");
    expect(env.content).toContain("ROOT_URL=http://localhost:5210");
    expect(env.content).not.toContain("MONGO"); // node plugin contributes no tail lines
  } finally {
    await rm(orch, { recursive: true, force: true });
  }
});

test("single-repo: createWorktree makes a feat/ worktree + branch off base", async () => {
  const orch = await makeSingleRepo();
  const project = basename(orch);
  try {
    const r = await createWorktree(orch, project, "x");
    expect(r.branch).toBe("feat/x");
    expect(r.port).toBe(5210);
    expect(await Bun.file(resolve(r.dir, ".env.worktree")).exists()).toBe(true);
  } finally {
    await rm(orch, { recursive: true, force: true });
  }
});
