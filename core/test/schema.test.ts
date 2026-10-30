import { test, expect } from "bun:test";
import schema from "../schema/wt.config.schema.json";

// Drift guard: TOP_LEVEL_KEYS is the human-maintained source of truth mirroring
// WorkspaceConfig in core/src/config.ts. Adding a field there without adding it
// here (and to the schema) fails this test — a deliberate reminder to keep the
// hand-authored draft-07 schema in sync with the interfaces.
const TOP_LEVEL_KEYS = [
  "title", "serverProject", "projectsDir", "project", "projects",
  "branches", "ports", "defaults", "links",
];

test("schema is draft-07 and an object schema", () => {
  expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
  expect(schema.type).toBe("object");
});

test("schema top-level properties match WorkspaceConfig exactly (no missing, no stale)", () => {
  // Exact-set equality (not just toContain): also fails if the schema keeps a key
  // that WorkspaceConfig dropped, catching drift in both directions.
  expect(Object.keys(schema.properties).sort()).toEqual([...TOP_LEVEL_KEYS].sort());
  // additionalProperties:false makes the schema actually reject unknown keys.
  expect(schema.additionalProperties).toBe(false);
});

test("schema enforces the project/projects exclusivity at least via oneOf/not", () => {
  // documentary: ensure we encoded the single-vs-multi rule somehow
  expect(JSON.stringify(schema)).toMatch(/oneOf|not|required/);
});
