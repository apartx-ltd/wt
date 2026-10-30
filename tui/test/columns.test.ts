import { test, expect } from "bun:test";
import { fitCell, columnWidth } from "../src/columns";

test("fitCell pads short values to width", () => {
  expect(fitCell("ab", 5)).toBe("ab   ");
  expect(fitCell("abcde", 5)).toBe("abcde");
});

test("fitCell truncates with an ellipsis when too long", () => {
  expect(fitCell("derived-rate-plans", 8)).toBe("derived…");
  expect(fitCell("xy", 1)).toBe("x");
});

test("columnWidth is the widest of header and cells", () => {
  expect(columnWidth("SLUG", ["a", "longer-slug"])).toBe("longer-slug".length);
  expect(columnWidth("BRANCH", ["x"])).toBe("BRANCH".length); // header wins
});

test("columnWidth clamps to min/max", () => {
  expect(columnWidth("PORT", ["4000"], { min: 6 })).toBe(6);
  expect(columnWidth("BRANCH", ["feature/really-long-branch-name"], { max: 10 })).toBe(10);
});
