import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { defineWorkspace, resolveConfig, validateConfig, loadConfig, resolveProjectConfig, resolveDockerizedProjects, resolveCoreStack, resolveLinkSpecs, resolveProjectsDir, resolveServerProject } from "../src/config";

// A multi-repo workspace written by the test: a dockerized core project (srv), a host-mode
// core project inheriting the plugin from defaults (web) and a node-plugin project (worker).
// Declared out of name order so the sorted core-stack contract is actually exercised.
const FIXTURE_LINKS = ["web:srv:env:SERVER_URL", "worker:srv:env:SERVER_URL"];
let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(resolve(tmpdir(), "wt-config-ws-"));
  writeFileSync(
    resolve(workspace, "wt.config.ts"),
    `import { defineWorkspace } from "@apartx/wt";\n` +
      `export default defineWorkspace({\n` +
      `  projectsDir: "projects",\n` +
      `  serverProject: "srv",\n` +
      `  defaults: { plugin: "@apartx/wt/plugin-meteor" },\n` +
      `  projects: {\n` +
      `    web: { core: { slug: "base" } },\n` +
      `    worker: { plugin: "@apartx/wt/plugin-node" },\n` +
      `    srv: { docker: { image: "meteor-dev:3.4" }, core: { slug: "base" } },\n` +
      `  },\n` +
      `  links: ${JSON.stringify(FIXTURE_LINKS)},\n` +
      `});\n`,
  );
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

test("defineWorkspace returns its argument unchanged (identity helper for types)", () => {
  const cfg = defineWorkspace({
    title: "t",
    projectsDir: "projects",
    branches: { base: "develop", prefix: "feature/" },
    defaults: { plugin: "@apartx/wt/plugin-meteor" },
    projects: { a: { docker: { image: "img:1" }, core: { slug: "base" } } },
    links: ["a:b:env:X"],
  });
  expect(cfg.title).toBe("t");
  expect(cfg.projects?.a?.docker?.image).toBe("img:1");
});

test("resolveConfig deep-merges defaults into each project (nested docker merged, scalars overridden)", () => {
  const r = resolveConfig({
    defaults: { plugin: "@apartx/wt/plugin-meteor", docker: { image: "base:1" } },
    projects: {
      a: { core: { slug: "base" } },                 // inherits plugin + docker.image
      b: { docker: { image: "own:2" } },             // overrides docker.image, inherits plugin
    },
  });
  expect(r.projects.a.plugin).toBe("@apartx/wt/plugin-meteor");
  expect(r.projects.a.docker?.image).toBe("base:1");
  expect(r.projects.a.core?.slug).toBe("base");
  expect(r.projects.b.plugin).toBe("@apartx/wt/plugin-meteor");
  expect(r.projects.b.docker?.image).toBe("own:2");
});

test("resolveConfig normalizes single-repo project to a one-entry map with projectsDir '.'", () => {
  const r = resolveConfig({
    project: { plugin: "@apartx/wt/plugin-node" },
    branches: { base: "main", prefix: "feat/" },
  }, "myapp");
  expect(r.projectsDir).toBe(".");
  expect(Object.keys(r.projects)).toEqual(["myapp"]);
  expect(r.projects.myapp.plugin).toBe("@apartx/wt/plugin-node");
});

test("resolveConfig defaults branches/ports/projectsDir when omitted", () => {
  const r = resolveConfig({ projects: { a: { plugin: "p" } } });
  expect(r.projectsDir).toBe("projects");
  expect(r.ports.step).toBe(10);
  expect(r.branches).toEqual({ base: "main", prefix: "feature/" });
});

test("validateConfig rejects both project and projects set", () => {
  expect(() => validateConfig({ project: { plugin: "p" }, projects: { a: { plugin: "p" } } }))
    .toThrow(/exactly one of `project` \/ `projects`/);
});

test("validateConfig rejects neither project nor projects", () => {
  expect(() => validateConfig({})).toThrow(/exactly one of `project` \/ `projects`/);
});

test("validateConfig rejects a project with no plugin after defaults", () => {
  expect(() => validateConfig({ projects: { a: { core: { slug: "base" } } } }))
    .toThrow(/project a: no plugin set/);
});

test("validateConfig passes a project that inherits plugin from defaults", () => {
  expect(() => validateConfig({ defaults: { plugin: "p" }, projects: { a: {} } })).not.toThrow();
});

test("a workspace wt.config.ts loads and validates", async () => {
  const cfg = await loadConfig(workspace);
  expect(cfg.projects.srv.plugin).toBe("@apartx/wt/plugin-meteor"); // from defaults
  expect(cfg.projects.srv.docker?.image).toBe("meteor-dev:3.4");
  expect(cfg.projects.web.plugin).toBe("@apartx/wt/plugin-meteor"); // from defaults
  expect(cfg.projects.web.docker).toBeUndefined();
  expect(cfg.projects.worker.plugin).toBe("@apartx/wt/plugin-node"); // own plugin wins
});

test("resolveProjectConfig: listed project from config, unlisted falls back to constants parity", async () => {
  // listed dockerized core project → from config
  const server = await resolveProjectConfig(workspace, "srv");
  expect(server.plugin).toBe("@apartx/wt/plugin-meteor");
  expect(server.docker?.image).toBe("meteor-dev:3.4");
  // unlisted project → fallback (constants); host-meteor, no docker.
  const unlisted = await resolveProjectConfig(workspace, "geoip");
  expect(unlisted.plugin).toBe("@apartx/wt/plugin-meteor");
  expect(unlisted.docker).toBeUndefined();
});

test("resolveDockerizedProjects returns only the docker-image projects", async () => {
  const names = [...(await resolveDockerizedProjects(workspace))];
  expect(names).toEqual(["srv"]);
  // host-mode, node-plugin and unlisted projects are never reported as dockerized
  expect(names).not.toContain("web");
  expect(names).not.toContain("worker");
  expect(names).not.toContain("geoip");
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
  // web is declared before srv, so the order proves the sort; worker has no core spec.
  expect(await resolveCoreStack(workspace)).toEqual([["srv", "base"], ["web", "base"]]);
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
  expect(await resolveLinkSpecs(workspace)).toEqual(FIXTURE_LINKS);
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
      `import { defineWorkspace } from "@apartx/wt";\n` +
        `export default defineWorkspace({ branches: { base: "main", prefix: "feat/" }, project: { plugin: "@apartx/wt/plugin-node" } });\n`,
    );
    expect(await resolveProjectsDir(orch)).toBe(".");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
  // multi-repo workspace → "projects"
  expect(await resolveProjectsDir(workspace)).toBe("projects");
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
  const r = resolveConfig({ serverProject: "srv", projects: { srv: { plugin: "@apartx/wt/plugin-node" } } }, "x");
  expect(r.serverProject).toBe("srv");
});

test("resolveConfig serverProject defaults to null", () => {
  const r = resolveConfig({ projects: { a: { plugin: "@apartx/wt/plugin-node" } } }, "x");
  expect(r.serverProject ?? null).toBeNull();
});

test("resolveServerProject reads serverProject from wt.config.ts; null when unset/no config", async () => {
  // explicit serverProject in a temp single-repo config
  const orch = mkdtempSync(resolve(tmpdir(), "wt-server-proj-"));
  try {
    writeFileSync(
      resolve(orch, "wt.config.ts"),
      `import { defineWorkspace } from "@apartx/wt";\n` +
        `export default defineWorkspace({ serverProject: "srv", projects: { srv: { plugin: "@apartx/wt/plugin-node" } } });\n`,
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
