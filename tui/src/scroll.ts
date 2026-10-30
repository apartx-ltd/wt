/** A rendered section: its first row's flat index and how many rows it holds. */
export interface RowGroup {
  start: number;
  count: number;
}

/**
 * Line offset (0-based) of the selected row within the scroll content, where each
 * section contributes one subtitle line above its rows. Returns -1 if `selected`
 * falls outside every group (e.g. an empty list).
 */
export function selectedLine(groups: RowGroup[], selected: number): number {
  let line = 0;
  for (const g of groups) {
    line += 1; // the section subtitle sits one line above its rows
    if (selected < g.start + g.count) return line + (selected - g.start);
    line += g.count;
  }
  return -1;
}

/**
 * Minimal scrollTop that keeps `line` inside a `viewport`-tall window: scroll up if
 * the line is above the window, down if it's below, otherwise leave it. A line of -1
 * or an unmeasured (0) viewport leaves the position untouched on the down path.
 */
export function clampScrollTop(top: number, line: number, viewport: number): number {
  if (line < 0) return top;
  if (line < top) return line;
  if (viewport > 0 && line >= top + viewport) return line - viewport + 1;
  return top;
}

/**
 * Cursor delta for a wheel tick. The list keeps the selected row in view by driving
 * scrollTop from the selection, but the scrollbox ALSO scrolls itself on a raw wheel
 * event — which slides the content out from under the (unmoved) cursor until it leaves
 * the viewport. Translating a vertical tick into a one-row selection move re-couples the
 * two: the selection-driven scroll then follows, so the cursor stays visible. Horizontal
 * ticks don't map to a row, so they leave the selection put.
 */
export function wheelSelectionDelta(direction: "up" | "down" | "left" | "right" | undefined): number {
  if (direction === "down") return 1;
  if (direction === "up") return -1;
  return 0;
}
