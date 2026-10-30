import { test, expect } from "bun:test";
import { resolveProjectArg, parseWebArgs } from "../src/args";

test("multi-repo: first positional is the project, rest shift down", () => {
  expect(resolveProjectArg(["apartx-cabinet", "feat-x"], { singleRepo: false }))
    .toEqual({ project: "apartx-cabinet", pos: ["feat-x"] });
});

test("single-repo: project is the sole project, positionals unshifted", () => {
  expect(resolveProjectArg(["feat-x"], { singleRepo: true, soleProject: "myapp" }))
    .toEqual({ project: "myapp", pos: ["feat-x"] });
});

test("single-repo with no args: project is sole project, empty positionals", () => {
  expect(resolveProjectArg([], { singleRepo: true, soleProject: "myapp" }))
    .toEqual({ project: "myapp", pos: [] });
});

test("multi-repo with no args: project undefined", () => {
  expect(resolveProjectArg([], { singleRepo: false }))
    .toEqual({ project: undefined, pos: [] });
});

test("web args: --dev toggles dev mode, none = built static", () => {
  expect(parseWebArgs([])).toEqual({ dev: false });
  expect(parseWebArgs(["--dev"])).toEqual({ dev: true });
});

test("web args: anything else is a usage error", () => {
  expect(() => parseWebArgs(["--prod"])).toThrow("usage: wt web [--dev]");
  expect(() => parseWebArgs(["x"])).toThrow("usage: wt web [--dev]");
});
