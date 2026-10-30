import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BASE_SLUG, computeWorktreeEnv, commitWorktreeEnv, regenerateWorktreeEnvPreserving, createWorktree, removeWorktree } from "../src/new-worktree";
import { readLedger } from "../src/ports";
import { registerBundledPlugins } from "#plugins";

// computeWorktreeEnv resolves the project's plugin (envLines) → the registry has to be populated.
beforeAll(() => registerBundledPlugins());

// wt.config.ts declaring the dockerized core projects — source of both the docker-gate
// (config.docker?.image) and the HMR-base index list (resolveDockerizedProjects).
// Imports defineWorkspace by absolute path so it loads from any temp orch dir.
const CONFIG_SRC = resolve(import.meta.dir, "../src/config");
const WT_CONFIG = `
import { defineWorkspace } from ${JSON.stringify(CONFIG_SRC)};
export default defineWorkspace({
  branches: { base: "develop", prefix: "feature/" },
  defaults: { plugin: "@apartx/wt/plugin-meteor" },
  projects: {
    "apartx-server": { docker: { image: "meteor-dev:3.4" } },
    "apartx-cabinet": { docker: { image: "meteor-dev:3.4" } },
    "apartx-admin": { docker: { image: "meteor-dev:3.4" } },
    "apartx-spaces": {},
  },
});
`;

function makeOrch(): string {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-new-"));
  mkdirSync(resolve(orch, "projects", "apartx-server"), { recursive: true });
  writeFileSync(
    resolve(orch, "projects", "apartx-server", ".env"),
    "PORT=4000\nMONGO_URL=mongodb://h:27017/apartx\n",
  );
  writeFileSync(resolve(orch, "wt.config.ts"), WT_CONFIG);
  mkdirSync(resolve(orch, "var"), { recursive: true });
  writeFileSync(resolve(orch, "var", "worktree-ports.tsv"), "apartx-server\tfeature/known\t10\n");
  return orch;
}

test("BASE_SLUG is the reserved base-checkout sentinel 'base'", () => {
  expect(BASE_SLUG).toBe("base");
});

test("createWorktree rejects reserved base slug", async () => {
  const orch = makeOrch();
  try {
    await expect(createWorktree(orch, "apartx-server", BASE_SLUG)).rejects.toThrow(/reserved/);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("removeWorktree rejects reserved base slug", async () => {
  const orch = makeOrch();
  try {
    await expect(removeWorktree(orch, "apartx-server", BASE_SLUG)).rejects.toThrow(/base checkout/);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("computeWorktreeEnv reuses ledger offset for known branch (read-only, isNew=false)", async () => {
  const orch = makeOrch();
  try {
    const r = await computeWorktreeEnv(orch, "apartx-server", "feature/known");
    expect(r).toMatchObject({ offset: 10, port: 4010, isNew: false });
    expect(r.content).toContain("PORT=4010\n");
    expect(r.content).not.toContain("MONGO_URL=");
    // read-only: ledger untouched
    expect(await readLedger(orch)).toHaveLength(1);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("computeWorktreeEnv allocates next free offset for new branch (isNew=true, no write)", async () => {
  const orch = makeOrch();
  try {
    const r = await computeWorktreeEnv(orch, "apartx-server", "feature/fresh");
    expect(r).toMatchObject({ offset: 20, port: 4020, isNew: true });
    expect(await readLedger(orch)).toHaveLength(1); // compute does not write
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("computeWorktreeEnv on non-dockerized project does not throw and omits HMR lines", async () => {
  // Regression: deterministicBaseHmrPort throws outside DOCKERIZED, while computeWorktreeEnv
  // is called for every project on `wt new`. A host-mode project without RSPACK_DEVSERVER_PORT
  // in .env must create a worktree without trouble (no HMR lines).
  const orch = mkdtempSync(resolve(tmpdir(), "wt-new-host-"));
  try {
    mkdirSync(resolve(orch, "projects", "apartx-spaces"), { recursive: true });
    writeFileSync(resolve(orch, "projects", "apartx-spaces", ".env"), "PORT=3500\n");
    const r = await computeWorktreeEnv(orch, "apartx-spaces", "feature/host");
    expect(r.content).toContain("PORT=3510\n");
    expect(r.content).not.toContain("RSPACK_DEVSERVER_PORT");
    expect(r.content).not.toContain("HMR_PUBLIC_PORT");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("computeWorktreeEnv isolated-db adds MONGO_URL from base .env", async () => {
  const orch = makeOrch();
  try {
    const r = await computeWorktreeEnv(orch, "apartx-server", "feature/iso", { isolatedDb: true });
    expect(r.content).toContain("MONGO_URL=mongodb://h:27017/apartx_iso\n");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("commitWorktreeEnv writes .env.worktree and appends ledger for new branch", async () => {
  const orch = makeOrch();
  const wtDir = resolve(orch, "worktrees", "apartx-server", "fresh");
  try {
    const r = await commitWorktreeEnv(orch, "apartx-server", "feature/fresh", wtDir);
    expect(r.isNew).toBe(true);
    expect(existsSync(resolve(wtDir, ".env.worktree"))).toBe(true);
    expect(readFileSync(resolve(wtDir, ".env.worktree"), "utf8")).toContain("PORT=4020\n");
    expect(await readLedger(orch)).toEqual([
      { project: "apartx-server", branch: "feature/known", offset: 10 },
      { project: "apartx-server", branch: "feature/fresh", offset: 20 },
    ]);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("commitWorktreeEnv does not duplicate ledger row for known branch", async () => {
  const orch = makeOrch();
  const wtDir = resolve(orch, "worktrees", "apartx-server", "known");
  try {
    await commitWorktreeEnv(orch, "apartx-server", "feature/known", wtDir);
    expect(await readLedger(orch)).toHaveLength(1); // already present → no append
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

// --- regenerateWorktreeEnvPreserving: self-heal stale/legacy .env.worktree ---

// Worktree directory for the known branch feature/known (offset 10 in the fixture's ledger).
function knownWtDir(orch: string): string {
  const d = resolve(orch, "worktrees", "apartx-server", "known");
  mkdirSync(d, { recursive: true });
  return d;
}

test("regenerate heals legacy .env.worktree missing HMR keys (keeps PORT, adds RSPACK/HMR)", async () => {
  const orch = makeOrch();
  const wtDir = knownWtDir(orch);
  try {
    // legacy: PORT/ROOT_URL + tail, WITHOUT RSPACK_DEVSERVER_PORT/HMR_PUBLIC_PORT
    writeFileSync(
      resolve(wtDir, ".env.worktree"),
      "PORT=4010\nROOT_URL=http://localhost:4010\nMONGO_OPLOG_URL=\nMONTI_APP_ID=\nMONTI_APP_SECRET=\n",
    );
    // HMR port = the same deterministic one computeWorktreeEnv emits for this branch
    // (apartx-server's dockerized index + offset 10). Compare against the canonical output, not a magic constant.
    const canonical = (await computeWorktreeEnv(orch, "apartx-server", "feature/known")).content;
    const hmr = /RSPACK_DEVSERVER_PORT=(\d+)/.exec(canonical)![1]!;
    await regenerateWorktreeEnvPreserving(orch, "apartx-server", "feature/known", wtDir);
    const out = readFileSync(resolve(wtDir, ".env.worktree"), "utf8");
    expect(out).toContain(`RSPACK_DEVSERVER_PORT=${hmr}\n`);
    expect(out).toContain(`HMR_PUBLIC_PORT=${hmr}\n`);
    expect(out).toContain("PORT=4010\n"); // unchanged
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("regenerate preserves isolated MONGO_URL (isolated stays isolated, inferred from presence)", async () => {
  const orch = makeOrch();
  const wtDir = knownWtDir(orch);
  try {
    writeFileSync(
      resolve(wtDir, ".env.worktree"),
      "PORT=4010\nROOT_URL=http://localhost:4010\nMONGO_URL=mongodb://h:27017/apartx_known\n",
    );
    await regenerateWorktreeEnvPreserving(orch, "apartx-server", "feature/known", wtDir);
    const out = readFileSync(resolve(wtDir, ".env.worktree"), "utf8");
    expect(out).toMatch(/^MONGO_URL=mongodb:\/\/h:27017\/apartx_known$/m);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("regenerate does NOT promote a shared worktree to isolated (no MONGO_URL gained)", async () => {
  const orch = makeOrch();
  const wtDir = knownWtDir(orch);
  try {
    writeFileSync(
      resolve(wtDir, ".env.worktree"),
      "PORT=4010\nROOT_URL=http://localhost:4010\n",
    );
    await regenerateWorktreeEnvPreserving(orch, "apartx-server", "feature/known", wtDir);
    const out = readFileSync(resolve(wtDir, ".env.worktree"), "utf8");
    expect(out).not.toContain("MONGO_URL=");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

// Project `env` from wt.config.ts: templates are expanded into .env.worktree. Motivation — CHATS_QUEUE_NS:
// without its own namespace, jobs from the shared Redis queue are picked up by any dev server (base, other branches).
function makeEnvOrch(): string {
  const orch = makeOrch();
  writeFileSync(
    resolve(orch, "wt.config.ts"),
    WT_CONFIG.replace(
      `"apartx-server": { docker: { image: "meteor-dev:3.4" } },`,
      `"apartx-server": { docker: { image: "meteor-dev:3.4" }, env: { CHATS_QUEUE_NS: "wt-\${branchSuffix}", X_PORT: "\${port}", X_OFFSET: "\${offset}" } },`,
    ),
  );
  return orch;
}

test("computeWorktreeEnv expands project env templates (${branchSuffix}/${port}/${offset})", async () => {
  const orch = makeEnvOrch();
  try {
    const r = await computeWorktreeEnv(orch, "apartx-server", "feature/known");
    expect(r.content).toContain("CHATS_QUEUE_NS=wt-known\n");
    expect(r.content).toContain("X_PORT=4010\n");
    expect(r.content).toContain("X_OFFSET=10\n");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("computeWorktreeEnv without project env adds no extra keys", async () => {
  const orch = makeOrch();
  try {
    const r = await computeWorktreeEnv(orch, "apartx-server", "feature/known");
    expect(r.content).not.toContain("CHATS_QUEUE_NS=");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("regenerate adds project env keys to an existing .env.worktree (managed, not duplicated)", async () => {
  const orch = makeEnvOrch();
  const wtDir = knownWtDir(orch);
  try {
    writeFileSync(resolve(wtDir, ".env.worktree"), "PORT=4010\nROOT_URL=http://localhost:4010\nCHATS_QUEUE_NS=stale\n");
    await regenerateWorktreeEnvPreserving(orch, "apartx-server", "feature/known", wtDir);
    const out = readFileSync(resolve(wtDir, ".env.worktree"), "utf8");
    expect(out.match(/^CHATS_QUEUE_NS=/gm)).toHaveLength(1);
    expect(out).toContain("CHATS_QUEUE_NS=wt-known\n");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("regenerate preserves manual non-managed keys verbatim", async () => {
  const orch = makeOrch();
  const wtDir = knownWtDir(orch);
  try {
    writeFileSync(
      resolve(wtDir, ".env.worktree"),
      "PORT=4010\nROOT_URL=http://localhost:4010\nMY_FLAG=1\n",
    );
    await regenerateWorktreeEnvPreserving(orch, "apartx-server", "feature/known", wtDir);
    const out = readFileSync(resolve(wtDir, ".env.worktree"), "utf8");
    expect(out).toContain("MY_FLAG=1\n");
    expect(out).not.toContain("\n\n"); // no blank-line artifacts
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("regenerate is idempotent on a canonically-generated file (byte-identical)", async () => {
  const orch = makeOrch();
  const wtDir = knownWtDir(orch);
  try {
    const canonical = (await computeWorktreeEnv(orch, "apartx-server", "feature/known")).content;
    writeFileSync(resolve(wtDir, ".env.worktree"), canonical);
    await regenerateWorktreeEnvPreserving(orch, "apartx-server", "feature/known", wtDir);
    expect(readFileSync(resolve(wtDir, ".env.worktree"), "utf8")).toBe(canonical);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("regenerate with missing file writes the canonical content (parity with commit-if-missing)", async () => {
  const orch = makeOrch();
  const wtDir = knownWtDir(orch); // dir exists, no .env.worktree
  try {
    expect(existsSync(resolve(wtDir, ".env.worktree"))).toBe(false);
    const canonical = (await computeWorktreeEnv(orch, "apartx-server", "feature/known")).content;
    await regenerateWorktreeEnvPreserving(orch, "apartx-server", "feature/known", wtDir);
    expect(readFileSync(resolve(wtDir, ".env.worktree"), "utf8")).toBe(canonical);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

// --- createWorktree: branch prefix + explicit fork base (M2.5) ---

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out;
}

// wt.config.ts with a test plugin (install=`true`, no docker) and base="develop",
// so that createWorktree does not run `meteor npm install` in the fixture.
const FORK_CONFIG = `
import { defineWorkspace } from ${JSON.stringify(CONFIG_SRC)};
import { registerPlugin, PLUGIN_API_VERSION } from ${JSON.stringify(resolve(import.meta.dir, "../src/plugin"))};
registerPlugin("@apartx/wt/plugin-noop", {
  name: "noop",
  apiVersion: PLUGIN_API_VERSION,
  install: () => ({ argv: ["true"] }),
  devCommand: () => ({ argv: ["true"] }),
});
export default defineWorkspace({
  branches: { base: "develop", prefix: "feature/" },
  defaults: { plugin: "@apartx/wt/plugin-noop" },
  projects: { "proj": {} },
});
`;

/**
 * Fixture: a real git repo project `proj` on branch `main` with a STRAY commit
 * on top of the `develop` tip. base config = "develop". Expectation: the new worktree branch
 * forks from `develop`, not from the current HEAD (`main` with the stray commit).
 */
async function makeForkOrch(): Promise<string> {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-fork-"));
  const pdir = resolve(orch, "projects", "proj");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(resolve(pdir, ".env"), "PORT=4000\n");
  writeFileSync(resolve(orch, "wt.config.ts"), FORK_CONFIG);
  mkdirSync(resolve(orch, "var"), { recursive: true });

  await git(pdir, "init", "-q", "-b", "main");
  await git(pdir, "config", "user.email", "t@t.t");
  await git(pdir, "config", "user.name", "t");
  writeFileSync(resolve(pdir, "a.txt"), "base\n");
  await git(pdir, "add", "-A");
  await git(pdir, "commit", "-q", "-m", "base");
  // develop points at the base tip
  await git(pdir, "branch", "develop");
  // STRAY commit on main on top of the develop tip
  writeFileSync(resolve(pdir, "b.txt"), "stray\n");
  await git(pdir, "add", "-A");
  await git(pdir, "commit", "-q", "-m", "stray on main");
  return orch;
}

test("createWorktree: branch uses configured prefix and forks from branches.base", async () => {
  const orch = await makeForkOrch();
  const pdir = resolve(orch, "projects", "proj");
  try {
    const r = await createWorktree(orch, "proj", "myfeat");

    // prefix from the config
    expect(r.branch).toBe("feature/myfeat");

    const baseTip = await git(pdir, "rev-parse", "develop");
    const strayTip = await git(pdir, "rev-parse", "main");
    const newTip = await git(pdir, "rev-parse", "feature/myfeat");

    // the new branch starts from the base tip (develop), not from main
    expect(newTip).toBe(baseTip);
    const mb = await git(pdir, "merge-base", "feature/myfeat", "develop");
    expect(mb).toBe(baseTip);

    // main's stray commit is NOT an ancestor of the new branch
    const isAncestor = await (async () => {
      const proc = Bun.spawn(
        ["git", "-C", pdir, "merge-base", "--is-ancestor", strayTip, newTip],
        { stdout: "ignore", stderr: "ignore" },
      );
      return (await proc.exited) === 0;
    })();
    expect(isAncestor).toBe(false);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("createWorktree: an unloadable plugin fails before git is touched (no worktree, no branch)", async () => {
  const orch = await makeForkOrch();
  const pdir = resolve(orch, "projects", "proj");
  // Same fixture, but the project uses a legacy plugin id that loadPlugin rejects.
  writeFileSync(
    resolve(orch, "wt.config.ts"),
    `import { defineWorkspace } from ${JSON.stringify(CONFIG_SRC)};
export default defineWorkspace({
  branches: { base: "develop", prefix: "feature/" },
  projects: { "proj": { plugin: "@wt/plugin-node" } },
});
`,
  );
  try {
    await expect(createWorktree(orch, "proj", "legacy")).rejects.toThrow(/was renamed/);
    expect(existsSync(resolve(orch, "worktrees", "proj", "legacy"))).toBe(false);
    expect(await git(pdir, "branch", "--list", "feature/legacy")).toBe("");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});
