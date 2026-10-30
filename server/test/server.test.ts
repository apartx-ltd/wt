import { test, expect, afterAll, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/index";
import { WT_PROTOCOL_VERSION, type Worktree, type RunInstance, type BaseSpec } from "#shared";

// Read paths now call @wt/core directly; inject the providers so tests stay hermetic
// (no real orchestrator/git). mergeInstances still runs in the server. Action paths
// (start/stop/rm/link/logs/new) keep going through the wt subprocess → wtBin stub.
const STUB = new URL("./fixtures/wt-stub.sh", import.meta.url).pathname;
// Explicit empty workspace root: the default resolveOrch() would search upward from cwd.
const ORCH = mkdtempSync(resolve(tmpdir(), "wt-server-orch-"));
const WORKTREES: Worktree[] = [
  { project: "apartx-cabinet", slug: "x", branch: "feature/x", port: 4231, path: "/w/x" },
  { project: "apartx-spaces", slug: "y", branch: "feature/y", port: 3512, path: "/w/y" },
];
const RUNNING: RunInstance[] = [
  { project: "apartx-cabinet", slug: "x", branch: "feature/x", port: 4231, pid: 12345, container: "wtdev-apartx-cabinet-x", started: 100, alive: true },
];
const READERS = {
  readWorktrees: async () => WORKTREES,
  readRunning: async () => RUNNING,
  readProjects: async () => ["apartx-server", "apartx-cabinet"],
  readBases: async () => [] as BaseSpec[],
};
const EMPTY_READERS = {
  readWorktrees: async () => [] as Worktree[],
  readRunning: async () => [] as RunInstance[],
  readProjects: async () => [] as string[],
  readBases: async () => [] as BaseSpec[],
};
const server = createServer({ wtBin: STUB, orch: ORCH, port: 0, pollMs: 50, ...READERS });
const emptyServer = createServer({ wtBin: STUB, orch: ORCH, port: 0, pollMs: 50, ...EMPTY_READERS });

afterAll(() => {
  server.stop(true);
  emptyServer.stop(true);
  rmSync(ORCH, { recursive: true, force: true });
});

test("GET /api/health reports the protocol version", async () => {
  const res = await fetch(`http://localhost:${server.port}/api/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ version: WT_PROTOCOL_VERSION });
});

test("GET /api/instances returns merged list", async () => {
  const res = await fetch(`http://localhost:${server.port}/api/instances`);
  expect(res.status).toBe(200);
  const body = await res.json();
  // cabinet/x is running (up); spaces/y is a worktree with no instance (down)
  const byKey = Object.fromEntries(body.map((i: any) => [`${i.project}/${i.slug}`, i.status]));
  expect(byKey["apartx-cabinet/x"]).toBe("up");
  expect(byKey["apartx-spaces/y"]).toBe("down");
});

test("GET /api/instances includes a synthetic base row from readBases", async () => {
  const s = createServer({
    wtBin: STUB,
    orch: ORCH,
    port: 0,
    pollMs: 50,
    readWorktrees: async () => [],
    readRunning: async () => [],
    readBases: async () => [{ project: "apartx-cabinet", branch: "develop", port: 3500 }],
  });
  const res = await fetch(`http://localhost:${s.port}/api/instances`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ project: "apartx-cabinet", slug: "base", port: 3500, status: "down" }),
    ]),
  );
  s.stop(true);
});

test("GET /api/events streams an initial instances event", async () => {
  const res = await fetch(`http://localhost:${server.port}/api/events`);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  expect(chunk).toContain("event: instances");
  await reader.cancel();
});

test("GET /api/events pushes an initial event even when the system is empty", async () => {
  const res = await fetch(`http://localhost:${emptyServer.port}/api/events`);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  expect(chunk).toContain("event: instances");
  expect(chunk).toContain("data: []");
  await reader.cancel();
});

test("POST .../stop awaits wt and returns its exit code", async () => {
  const res = await fetch(
    `http://localhost:${server.port}/api/instances/apartx-cabinet/x/stop`,
    { method: "POST" },
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ code: 0 });
});

test("POST .../start is fire-and-forget (202 ok)", async () => {
  const res = await fetch(
    `http://localhost:${server.port}/api/instances/apartx-cabinet/x/start`,
    { method: "POST" },
  );
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true });
});

test("GET .../logs streams log lines as SSE", async () => {
  const res = await fetch(`http://localhost:${server.port}/api/instances/apartx-cabinet/x/logs`);
  expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  let text = "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  for (let i = 0; i < 50; i++) {
    const { value, done } = await reader.read();
    if (value) text += dec.decode(value);
    if (done || text.includes("mongo connected")) break;
  }
  await reader.cancel();
  expect(text).toContain("event: log");
  expect(text).toContain("App running");
  expect(text).toContain("mongo connected");
});

test("the spawned wt CLI gets the server's workspace root as WT_ORCH", async () => {
  // Stub echoes $WT_ORCH for `logs wt-orch …`; the server's orch is ORCH, not the test's cwd.
  const res = await fetch(`http://localhost:${server.port}/api/instances/wt-orch/x/logs`);
  const expected = `data: ${JSON.stringify(`WT_ORCH=${ORCH}`)}`;
  let text = "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  for (let i = 0; i < 50; i++) {
    const { value, done } = await reader.read();
    if (value) text += dec.decode(value);
    if (done || text.includes("WT_ORCH=")) break;
  }
  await reader.cancel();
  expect(text).toContain(expected);
});

test("unknown action method → 405", async () => {
  const res = await fetch(`http://localhost:${server.port}/api/instances/p/s/stop`);
  expect(res.status).toBe(405);
});

test("GET /api/projects lists project names", async () => {
  const res = await fetch(`http://localhost:${server.port}/api/projects`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(["apartx-server", "apartx-cabinet"]);
});

test("POST /api/worktrees is fire-and-forget (202)", async () => {
  const res = await fetch(`http://localhost:${server.port}/api/worktrees`, {
    method: "POST",
    body: JSON.stringify({ project: "apartx-server", slug: "feat-x", isolatedDb: true }),
  });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true });
});

test("POST /api/worktrees requires project + slug (400)", async () => {
  const res = await fetch(`http://localhost:${server.port}/api/worktrees`, {
    method: "POST",
    body: JSON.stringify({ project: "apartx-server" }),
  });
  expect(res.status).toBe(400);
});

test("DELETE /api/worktrees/:p/:slug returns exit code", async () => {
  const res = await fetch(
    `http://localhost:${server.port}/api/worktrees/apartx-cabinet/x`,
    { method: "DELETE" },
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ code: 0 });
});

test("GET /api/meta returns the injected title", async () => {
  const s = createServer({ wtBin: STUB, orch: ORCH, port: 0, pollMs: 50, ...READERS, readTitle: async () => "My Workspace" });
  const res = await fetch(`http://localhost:${s.port}/api/meta`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ title: "My Workspace" });
  s.stop(true);
});

test("GET /api/meta returns null title when unset", async () => {
  const s = createServer({ wtBin: STUB, orch: ORCH, port: 0, pollMs: 50, ...READERS, readTitle: async () => null });
  const res = await fetch(`http://localhost:${s.port}/api/meta`);
  expect(await res.json()).toEqual({ title: null });
  s.stop(true);
});

test("POST .../link and .../unlink return exit codes", async () => {
  const link = await fetch(`http://localhost:${server.port}/api/instances/apartx-cabinet/x/link`, {
    method: "POST",
    body: JSON.stringify({ linkSlug: "x" }),
  });
  expect(await link.json()).toEqual({ code: 0 });
  const unlink = await fetch(`http://localhost:${server.port}/api/instances/apartx-cabinet/x/unlink`, {
    method: "POST",
  });
  expect(await unlink.json()).toEqual({ code: 0 });
});

describe("static dashboard (staticDir)", () => {
  const STATIC = mkdtempSync(resolve(tmpdir(), "wt-server-static-"));
  const INDEX = "<!doctype html><title>wt</title>";
  mkdirSync(resolve(STATIC, "assets"));
  writeFileSync(resolve(STATIC, "index.html"), INDEX);
  writeFileSync(resolve(STATIC, "assets/a.js"), "console.log(1);");
  // A file next to (outside) staticDir that a traversal must not reach.
  const SECRET = `${STATIC}-secret.txt`;
  writeFileSync(SECRET, "secret");
  const s = createServer({ wtBin: STUB, orch: ORCH, port: 0, pollMs: 50, ...READERS, staticDir: STATIC });
  const base = `http://localhost:${s.port}`;

  afterAll(() => {
    s.stop(true);
    rmSync(STATIC, { recursive: true, force: true });
    rmSync(SECRET, { force: true });
  });

  test("GET / serves index.html as text/html", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(INDEX);
  });

  test("GET /assets/a.js serves the file with a JavaScript content type", async () => {
    const res = await fetch(`${base}/assets/a.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^(application|text)\/javascript/);
    expect(await res.text()).toBe("console.log(1);");
  });

  test("unknown non-/api paths fall back to index.html (SPA routing)", async () => {
    const res = await fetch(`${base}/anything/deep`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(INDEX);
  });

  test("/api routes still answer JSON", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: WT_PROTOCOL_VERSION });
  });

  test("unknown /api paths stay 404 (no index.html fallback)", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
  });

  test("path traversal cannot escape staticDir", async () => {
    // The URL parser collapses `..` and `%2e%2e/` segments, but keeps `..%2f`; a naive
    // decodeURIComponent of the pathname would turn that into `../<secret>`.
    const name = SECRET.slice(SECRET.lastIndexOf("/") + 1);
    const res = await fetch(`${base}/..%2f${name}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toBe("secret");
  });
});

test("without staticDir non-/api paths are 404", async () => {
  const res = await fetch(`http://localhost:${server.port}/`);
  expect(res.status).toBe(404);
});
