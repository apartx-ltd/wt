import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const bin = resolve(import.meta.dir, "..", "bin", "wt.ts");
const CONFIG_SRC = resolve(import.meta.dir, "..", "..", "core", "src", "config");

async function wt(orch: string, ...args: string[]) {
  const env = { ...process.env, WT_ORCH: orch };
  const proc = Bun.spawn([process.execPath, bin, ...args], { cwd: orch, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/** A multi-repo workspace with project `api`, whose base checkout has the given `.env` (or none). */
function makeWorkspace(env?: string): string {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-port-"));
  const pdir = resolve(orch, "projects", "api");
  mkdirSync(resolve(pdir, ".git"), { recursive: true });
  if (env !== undefined) writeFileSync(resolve(pdir, ".env"), env);
  writeFileSync(
    resolve(orch, "wt.config.ts"),
    `import { defineWorkspace } from ${JSON.stringify(CONFIG_SRC)};
export default defineWorkspace({ defaults: { plugin: "@apartx/wt/plugin-node" }, projects: { api: {} } });
`,
  );
  return orch;
}

test("wt port <p> prints the base port", async () => {
  const orch = makeWorkspace("PORT=3000\n");
  try {
    const { stdout, code } = await wt(orch, "port", "api");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("3000");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("wt port <p> without a PORT exits 1 with an error instead of an empty line", async () => {
  const orch = makeWorkspace("OTHER=1\n");
  try {
    const { stdout, stderr, code } = await wt(orch, "port", "api");
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("api: no PORT found");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});
