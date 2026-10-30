/** Pad/truncate a cell to an exact width (ellipsis when it overflows). */
export function fitCell(s: string, width: number): string {
  if (width <= 0) return "";
  if (s.length === width) return s;
  if (s.length < width) return s.padEnd(width);
  if (width === 1) return s.slice(0, 1);
  return s.slice(0, width - 1) + "…";
}

/** Width for a column: widest of header/cells, clamped to optional min/max. */
export function columnWidth(
  header: string,
  cells: string[],
  opts: { min?: number; max?: number } = {},
): number {
  let w = header.length;
  for (const c of cells) if (c.length > w) w = c.length;
  if (opts.min !== undefined) w = Math.max(w, opts.min);
  if (opts.max !== undefined) w = Math.min(w, opts.max);
  return w;
}
