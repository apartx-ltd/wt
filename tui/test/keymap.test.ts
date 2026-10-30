import { test, expect } from "bun:test";
import { resolveKey, resolveConfirm } from "../src/keymap";

test("arrow keys navigate (layout-independent)", () => {
  expect(resolveKey("down")).toBe("down");
  expect(resolveKey("up")).toBe("up");
});

test("vim keys navigate (Latin layout)", () => {
  expect(resolveKey("j")).toBe("down");
  expect(resolveKey("k")).toBe("up");
});

test("Russian ЙЦУКЕН positional letters navigate (physical j/k)", () => {
  expect(resolveKey("о")).toBe("down");
  expect(resolveKey("л")).toBe("up");
});

test("quit keys", () => {
  expect(resolveKey("escape")).toBe("quit");
  expect(resolveKey("q")).toBe("quit");
  expect(resolveKey("й")).toBe("quit"); // physical q on ru layout
  expect(resolveKey("c", { ctrl: true })).toBe("quit");
  expect(resolveKey("с", { ctrl: true })).toBe("quit"); // ru ctrl-c
  expect(resolveKey("c")).toBeNull(); // plain c is not quit
});

test("action keys (Latin + ru positional)", () => {
  expect(resolveKey("s")).toBe("start");
  expect(resolveKey("ы")).toBe("start"); // physical s on ru layout
  expect(resolveKey("x")).toBe("stop");
  expect(resolveKey("ч")).toBe("stop"); // physical x on ru layout
  expect(resolveKey("r")).toBe("restart");
  expect(resolveKey("к")).toBe("restart"); // physical r on ru layout
  expect(resolveKey("d")).toBe("rm");
  expect(resolveKey("в")).toBe("rm"); // physical d on ru layout
  expect(resolveKey("n")).toBe("new");
  expect(resolveKey("т")).toBe("new"); // physical n on ru layout
  expect(resolveKey("l")).toBe("link");
  expect(resolveKey("д")).toBe("link"); // physical l on ru layout
  expect(resolveKey("u")).toBe("unlink");
  expect(resolveKey("г")).toBe("unlink"); // physical u on ru layout
});

test("modal confirm keys (Latin + ru positional)", () => {
  expect(resolveConfirm("y")).toBe("confirm");
  expect(resolveConfirm("н")).toBe("confirm"); // physical y
  expect(resolveConfirm("b")).toBe("confirmBranch");
  expect(resolveConfirm("и")).toBe("confirmBranch"); // physical b
  expect(resolveConfirm("n")).toBe("cancel");
  expect(resolveConfirm("т")).toBe("cancel"); // physical n
  expect(resolveConfirm("escape")).toBe("cancel");
  expect(resolveConfirm("z")).toBeNull();
});

test("unmapped key", () => {
  expect(resolveKey("z")).toBeNull();
});
