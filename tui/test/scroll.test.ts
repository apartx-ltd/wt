import { test, expect } from "bun:test";
import { selectedLine, clampScrollTop, wheelSelectionDelta, type RowGroup } from "../src/scroll";

// worktrees section (3 rows, flat 0..2) then base section (2 rows, flat 3..4)
const GROUPS: RowGroup[] = [
  { start: 0, count: 3 },
  { start: 3, count: 2 },
];

test("selectedLine accounts for the subtitle line above each section", () => {
  expect(selectedLine(GROUPS, 0)).toBe(1); // subtitle@0, first worktree row@1
  expect(selectedLine(GROUPS, 2)).toBe(3); // last worktree row
  expect(selectedLine(GROUPS, 3)).toBe(5); // subtitle@0, rows@1..3, base subtitle@4, first base row@5
  expect(selectedLine(GROUPS, 4)).toBe(6); // last base row
});

test("selectedLine with a single section has one subtitle line", () => {
  expect(selectedLine([{ start: 0, count: 2 }], 0)).toBe(1);
  expect(selectedLine([{ start: 0, count: 2 }], 1)).toBe(2);
});

test("selectedLine returns -1 when the index is outside every group", () => {
  expect(selectedLine(GROUPS, 99)).toBe(-1);
  expect(selectedLine([], 0)).toBe(-1);
});

test("clampScrollTop scrolls down to keep a below-window line at the bottom", () => {
  expect(clampScrollTop(0, 5, 4)).toBe(2); // window [0,3] → [2,5]
});

test("clampScrollTop scrolls up to a line above the window", () => {
  expect(clampScrollTop(2, 1, 4)).toBe(1);
});

test("clampScrollTop leaves an in-window line untouched", () => {
  expect(clampScrollTop(0, 2, 4)).toBe(0);
});

test("clampScrollTop never moves on a -1 line or an unmeasured viewport", () => {
  expect(clampScrollTop(3, -1, 4)).toBe(3);
  expect(clampScrollTop(0, 5, 0)).toBe(0);
});

test("wheelSelectionDelta maps a vertical wheel tick to a one-row cursor move", () => {
  // A wheel scroll must move the SELECTION (not the scrollbox alone): the cursor is
  // kept in view by the selection-driven effect, so coupling them keeps it visible.
  expect(wheelSelectionDelta("down")).toBe(1);
  expect(wheelSelectionDelta("up")).toBe(-1);
});

test("wheelSelectionDelta ignores horizontal scroll", () => {
  expect(wheelSelectionDelta("left")).toBe(0);
  expect(wheelSelectionDelta("right")).toBe(0);
  expect(wheelSelectionDelta(undefined)).toBe(0);
});
