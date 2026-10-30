import { For, createMemo, createEffect } from "solid-js";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { MergedInstance } from "@wt/shared";
import { sections } from "@wt/shared";
import { statusDot, uptime } from "./format";
import { fitCell, columnWidth } from "./columns";
import { selectedLine, clampScrollTop, wheelSelectionDelta } from "./scroll";

// opentui dispatches mouse input through a renderable's `onMouseEvent`; we only read the
// scroll bits. Typed locally to avoid importing (and clashing with) the DOM MouseEvent.
type ScrollMouseEvent = { type: string; scroll?: { direction: "up" | "down" | "left" | "right" } };

export function InstanceList(props: {
  instances: MergedInstance[];
  selected: number;
  now: number;
  onScroll: (delta: number) => void;
}) {
  // Widths are derived from the data (clamped) so columns line up regardless of
  // how long a slug/branch is; the header uses the same widths.
  const w = createMemo(() => {
    const list = props.instances;
    return {
      project: columnWidth("PROJECT", list.map((i) => i.project), { max: 18 }),
      slug: columnWidth("SLUG", list.map((i) => i.slug), { max: 22 }),
      branch: columnWidth("BRANCH", list.map((i) => i.branch), { max: 28 }),
      port: columnWidth("PORT", list.map((i) => String(i.port ?? "-")), { min: 4 }),
      status: columnWidth("STATUS", list.map((i) => i.status), { min: 4 }),
    };
  });

  // Group rows into ordered sections (worktrees first, then base) while tracking a
  // running flat offset so each row keeps its original flat index into props.instances
  // — subtitles are render-only decorations, the flat index must stay aligned.
  const groups = createMemo(() => {
    let offset = 0;
    return sections(props.instances).map((s) => {
      const start = offset;
      offset += s.rows.length;
      return { ...s, start };
    });
  });

  // The list can outgrow the viewport (every project contributes a base row), so the
  // rows live in a <scrollbox>. Whenever the selection (or the list) changes we keep
  // the selected row in view by driving scrollTop directly — computed from the row's
  // line offset (each section adds one subtitle line above its rows) and the live
  // viewport height. Done by line math rather than scrollChildIntoView so it doesn't
  // depend on per-row id lookup or layout-timing of culled rows.
  let scroll: ScrollBoxRenderable | undefined;
  createEffect(() => {
    const sb = scroll;
    const idx = props.selected;
    const gs = groups(); // also re-runs after a poll reorders/resizes the list
    if (!sb) return;
    const line = selectedLine(gs.map((g) => ({ start: g.start, count: g.rows.length })), idx);
    const next = clampScrollTop(sb.scrollTop, line, sb.viewport.height);
    if (next !== sb.scrollTop) sb.scrollTop = next;
  });

  return (
    <box flexDirection="column" flexGrow={2} flexShrink={1} minHeight={0}>
      <text flexShrink={0} fg="#8b949e" wrapMode="none">
        {`  ${fitCell("PROJECT", w().project)} ${fitCell("SLUG", w().slug)} ${fitCell("BRANCH", w().branch)} ${fitCell("PORT", w().port)} STATUS`}
      </text>
      <scrollbox
        ref={(el: ScrollBoxRenderable) => {
          scroll = el;
          // Left to itself the scrollbox scrolls on a raw wheel event (opentui's native
          // onMouseEvent mutates scrollTop, with acceleration) — a SECOND writer of
          // scrollTop that races the selection-driven effect below: the view slides off
          // the cursor and only snaps back when the selected line happens to leave the
          // window. Override onMouseEvent so the wheel ONLY moves the selection; scrollTop
          // then has a single writer (the effect), so the cursor can never detach.
          (el as unknown as { onMouseEvent: (e: ScrollMouseEvent) => void }).onMouseEvent = (e) => {
            if (e.type !== "scroll") return;
            const delta = wheelSelectionDelta(e.scroll?.direction);
            if (delta !== 0) props.onScroll(delta);
          };
        }}
        scrollY={true}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
      >
        <For each={groups()}>
          {(g) => (
            <box flexDirection="column">
              <text fg="#6e7681" wrapMode="none">{`── ${g.label} ──`}</text>
              <For each={g.rows}>
                {(i, rowIdx) => {
                  const dot = statusDot(i.status);
                  // Inline the dynamic bits (g.start + rowIdx()/props.selected, props.now,
                  // w()) directly in the template so Solid tracks them — cursor, widths &
                  // uptime stay live.
                  const selected = () => g.start + rowIdx() === props.selected;
                  return (
                    <text
                      wrapMode="none"
                      bg={selected() ? "#1f6feb" : undefined}
                      fg={selected() ? "#ffffff" : undefined}
                      attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE}
                    >
                      {`${selected() ? "▸" : " "} ${fitCell(i.project, w().project)} ${fitCell(i.slug, w().slug)} ${fitCell(i.branch, w().branch)} ${fitCell(String(i.port ?? "-"), w().port)} `}
                      <span style={{ fg: dot.fg }}>{dot.glyph}</span>
                      {/* Pad the trailing (variable-length) status+uptime to a fixed width so the
                          highlight bar has a stable right edge and doesn't jitter as uptime ticks. */}
                      {` ${fitCell(i.status, w().status)} ${uptime(i.started, props.now)}`.padEnd(w().status + 9)}
                    </text>
                  );
                }}
              </For>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  );
}
