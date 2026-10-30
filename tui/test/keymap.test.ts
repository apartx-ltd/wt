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

// Cyrillic keys are written as \u{…} escapes (same runtime strings) so the source stays English-only text.
test("Russian JCUKEN positional letters navigate (physical j/k)", () => {
  expect(resolveKey("\u{43e}")).toBe("down");
  expect(resolveKey("\u{43b}")).toBe("up");
});

test("quit keys", () => {
  expect(resolveKey("escape")).toBe("quit");
  expect(resolveKey("q")).toBe("quit");
  expect(resolveKey("\u{439}")).toBe("quit"); // physical q on ru layout
  expect(resolveKey("c", { ctrl: true })).toBe("quit");
  expect(resolveKey("\u{441}", { ctrl: true })).toBe("quit"); // ru ctrl-c
  expect(resolveKey("c")).toBeNull(); // plain c is not quit
});

test("action keys (Latin + ru positional)", () => {
  expect(resolveKey("s")).toBe("start");
  expect(resolveKey("\u{44b}")).toBe("start"); // physical s on ru layout
  expect(resolveKey("x")).toBe("stop");
  expect(resolveKey("\u{447}")).toBe("stop"); // physical x on ru layout
  expect(resolveKey("r")).toBe("restart");
  expect(resolveKey("\u{43a}")).toBe("restart"); // physical r on ru layout
  expect(resolveKey("d")).toBe("rm");
  expect(resolveKey("\u{432}")).toBe("rm"); // physical d on ru layout
  expect(resolveKey("n")).toBe("new");
  expect(resolveKey("\u{442}")).toBe("new"); // physical n on ru layout
  expect(resolveKey("l")).toBe("link");
  expect(resolveKey("\u{434}")).toBe("link"); // physical l on ru layout
  expect(resolveKey("u")).toBe("unlink");
  expect(resolveKey("\u{433}")).toBe("unlink"); // physical u on ru layout
});

test("modal confirm keys (Latin + ru positional)", () => {
  expect(resolveConfirm("y")).toBe("confirm");
  expect(resolveConfirm("\u{43d}")).toBe("confirm"); // physical y
  expect(resolveConfirm("b")).toBe("confirmBranch");
  expect(resolveConfirm("\u{438}")).toBe("confirmBranch"); // physical b
  expect(resolveConfirm("n")).toBe("cancel");
  expect(resolveConfirm("\u{442}")).toBe("cancel"); // physical n
  expect(resolveConfirm("escape")).toBe("cancel");
  expect(resolveConfirm("z")).toBeNull();
});

test("unmapped key", () => {
  expect(resolveKey("z")).toBeNull();
});
