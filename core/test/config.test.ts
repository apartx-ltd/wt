import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { defineWorkspace, resolveConfig, validateConfig, loadConfig, resolveProjectConfig, resolveDockerizedProjects, resolveCoreStack, resolveLinkSpecs, resolveProjectsDir, resolveServerProject } from "../src/config";

// orch root = 4 levels up from tools/wt/core/test → the repo root (works in the worktree AND after merge).
function resolveOrchRoot(): string {
  return resolve(import.meta.dir, "../../../..");
}

test("defineWorkspace returns its argument unchanged (identity helper for types)", () => {
  const cfg = defineWorkspace({
    title: "t",
    projectsDir: "projects",
    branches: { base: "develop", prefix: "feature/" },
    defaults: { plugin: "@wt/plugin-meteor" },
    projects: { a: { docker: { image: "img:1" }, core: { slug: "base" } } },
    links: ["a:b:env:X"],
  });
  expect(cfg.title).toBe("t");
  expect(cfg.projects?.a?.docker?.image).toBe("img:1");
});

test("resolveConfig deep-merges defaults into each project (nested docker merged, scalars overridden)", () => {
  const r = resolveConfig({
    defaults: { plugin: "@wt/plugin-meteor", docker: { image: "base:1" } },
    projects: {
      a: { core: { slug: "base" } },                 // inherits plugin + docker.image
      b: { docker: { image: "own:2" } },             // overrides docker.image, inherits plugin
    },
  });
  expect(r.projects.a.plugin).toBe("@wt/plugin-meteor");
  expect(r.projects.a.docker?.image).toBe("base:1");
  expect(r.projects.a.core?.slug).toBe("base");
  expect(r.projects.b.plugin).toBe("@wt/plugin-meteor");
  expect(r.projects.b.docker?.image).toBe("own:2");
});

test("resolveConfig normalizes single-repo project to a one-entry map with projectsDir '.'", () => {
  const r = resolveConfig({
    project: { plugin: "@wt/plugin-node" },
    branches: { base: "main", prefix: "feat/" },
  }, "myapp");
  expect(r.projectsDir).toBe(".");
  expect(Object.keys(r.projects)).toEqual(["myapp"]);
  expect(r.projects.myapp.plugin).toBe("@wt/plugin-node");
});

test("resolveConfig defaults branches/ports/projectsDir when omitted", () => {
  const r = resolveConfig({ projects: { a: { plugin: "p" } } });
  expect(r.projectsDir).toBe("projects");
  expect(r.ports.step).toBe(10);
  expect(r.branches).toEqual({ base: "main", prefix: "feature/" });
});

test("validateConfig rejects both project and projects set", () => {
  expect(() => validateConfig({ project: { plugin: "p" }, projects: { a: { plugin: "p" } } }))
    .toThrow(/ровно один из `project` \/ `projects`/);
});

test("validateConfig rejects neither project nor projects", () => {
  expect(() => validateConfig({})).toThrow(/ровно один из `project` \/ `projects`/);
});

test("validateConfig rejects a project with no plugin after defaults", () => {
  expect(() => validateConfig({ projects: { a: { core: { slug: "base" } } } }))
    .toThrow(/проект a: не задан plugin/);
});

test("validateConfig passes a project that inherits plugin from defaults", () => {
  expect(() => validateConfig({ defaults: { plugin: "p" }, projects: { a: {} } })).not.toThrow();
});

test("apartx wt.config.ts loads and validates", async () => {
  const cfg = await loadConfig(resolveOrchRoot());
  expect(cfg.projects["apartx-server"].plugin).toBe("@wt/plugin-meteor");
  expect(cfg.projects["apartx-server"].docker?.image).toBe("meteor-dev:3.4");
  expect(cfg.projects["apartx-spaces"].plugin).toBe("@wt/plugin-meteor"); // from defaults
});

test("resolveProjectConfig: listed project from config, unlisted falls back to constants parity", async () => {
  const orch = resolveOrchRoot();
  // listed dockerized core project → from config (mirrors constants exactly)
  const server = await resolveProjectConfig(orch, "apartx-server");
  expect(server.plugin).toBe("@wt/plugin-meteor");
  expect(server.docker?.image).toBe("meteor-dev:3.4");
  // unlisted host project → fallback (constants); host-meteor, no docker.
  // Имя нельзя брать «на глазок»: раньше здесь стоял apartx-whatsapp, его перевели в
  // docker — и тест покраснел от правки конфига, а не движка. Нужен проект, который
  // в wt.config.ts не объявлен (apartx-geoip — host-режим).
  const unlisted = await resolveProjectConfig(orch, "apartx-geoip");
  expect(unlisted.plugin).toBe("@wt/plugin-meteor");
  expect(unlisted.docker).toBeUndefined();
});

test("resolveDockerizedProjects returns the docker-image projects, sorted, contract-checked", async () => {
  // Contract over the engine, NOT a 1:1 mirror of wt.config.ts data: editing the
  // dockerized set in the orchestrator config must not break @wt/core tests.
  const names = [...(await resolveDockerizedProjects(resolveOrchRoot()))];
  // the always-dockerized core stack is present
  expect(names).toContain("apartx-server");
  expect(names).toContain("apartx-cabinet");
  expect(names).toContain("apartx-admin");
  // an unlisted host-mode project is never reported as dockerized
  expect(names).not.toContain("apartx-geoip");
});

test("resolveDockerizedProjects returns [] when no wt.config.ts exists", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-no-config-"));
  try {
    expect(await resolveDockerizedProjects(orch)).toEqual([]);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("resolveCoreStack returns [project, slug] pairs for projects with a core spec, sorted by name", async () => {
  // Contract, not a data mirror: every entry is a [name, slug] pair, the list is
  // sorted by name, and the core services are present with their base slug.
  const stack = await resolveCoreStack(resolveOrchRoot());
  expect(stack.length).toBeGreaterThan(0);
  for (const entry of stack) expect(entry).toHaveLength(2);
  const names = stack.map(([name]) => name);
  expect(names).toEqual([...names].sort());
  expect(stack).toContainEqual(["apartx-server", "base"]);
  expect(stack).toContainEqual(["apartx-cabinet", "base"]);
});

test("resolveCoreStack returns [] when there is no wt.config.ts", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-no-config-"));
  try {
    expect(await resolveCoreStack(orch)).toEqual([]);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("resolveLinkSpecs returns the config links verbatim", async () => {
  const links = await resolveLinkSpecs(resolveOrchRoot());
  expect(links).toContain("apartx-cabinet:apartx-server:env:SERVER_URL");
});

test("resolveLinkSpecs returns [] when there is no wt.config.ts", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-no-config-"));
  try {
    expect(await resolveLinkSpecs(orch)).toEqual([]);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("resolveProjectsDir returns '.' for single-repo config, 'projects' for multi", async () => {
  // single-repo: temp wt.config.ts with `project:` → "."
  const orch = mkdtempSync(resolve(tmpdir(), "wt-single-pd-"));
  try {
    writeFileSync(
      resolve(orch, "wt.config.ts"),
      `import { defineWorkspace } from "${resolve(import.meta.dir, "../src/config")}";\n` +
        `export default defineWorkspace({ branches: { base: "main", prefix: "feat/" }, project: { plugin: "@wt/plugin-node" } });\n`,
    );
    expect(await resolveProjectsDir(orch)).toBe(".");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
  // apartx (multi-repo) → "projects"
  expect(await resolveProjectsDir(resolveOrchRoot())).toBe("projects");
});

test("resolveProjectsDir returns 'projects' when there is no wt.config.ts", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-no-config-"));
  try {
    expect(await resolveProjectsDir(orch)).toBe("projects");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("resolveConfig carries serverProject", () => {
  const r = resolveConfig({ serverProject: "srv", projects: { srv: { plugin: "@wt/plugin-node" } } }, "x");
  expect(r.serverProject).toBe("srv");
});

test("resolveConfig serverProject defaults to null", () => {
  const r = resolveConfig({ projects: { a: { plugin: "@wt/plugin-node" } } }, "x");
  expect(r.serverProject ?? null).toBeNull();
});

test("resolveServerProject reads serverProject from wt.config.ts; null when unset/no config", async () => {
  // explicit serverProject in a temp single-repo config
  const orch = mkdtempSync(resolve(tmpdir(), "wt-server-proj-"));
  try {
    writeFileSync(
      resolve(orch, "wt.config.ts"),
      `import { defineWorkspace } from "${resolve(import.meta.dir, "../src/config")}";\n` +
        `export default defineWorkspace({ serverProject: "srv", projects: { srv: { plugin: "@wt/plugin-node" } } });\n`,
    );
    expect(await resolveServerProject(orch)).toBe("srv");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
  // no wt.config.ts → null
  const empty = mkdtempSync(resolve(tmpdir(), "wt-no-config-"));
  try {
    expect(await resolveServerProject(empty)).toBeNull();
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
