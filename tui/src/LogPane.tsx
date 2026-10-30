import { For, Show } from "solid-js";

/**
 * Thin presentational pane for the selected instance's logs. Data-free by design:
 * the follow stream lives in App state (per the design's "keep components thin")
 * so all the streaming/parsing logic stays in tested pure code.
 *
 * The pane flexGrows to own its share of the vertical space; the lines live in a
 * <scrollbox> with stickyScroll anchored to the bottom, so the newest line is always
 * in view as logs stream in — no manual line-budget math, and the list can never be
 * pushed off-screen by a noisy log.
 */
export function LogPane(props: { title: string; lines: string[] }) {
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      overflow="hidden"
      borderStyle="rounded"
      paddingLeft={1}
      paddingRight={1}
    >
      <text flexShrink={0} fg="#58a6ff" wrapMode="none">{`logs · ${props.title}`}</text>
      <Show
        when={props.lines.length > 0}
        fallback={<text fg="#6e7681">{"no logs"}</text>}
      >
        {/* Live repaint is handled by the renderer's continuous loop (App holds a
            requestLive() for the dashboard's lifetime), so appended lines paint as
            they arrive. stickyScroll keeps the view pinned to the newest line.
            overflow + wrapMode:"none" clip long JSON log lines to a single row. */}
        <scrollbox scrollY={true} stickyScroll={true} stickyStart="bottom" flexGrow={1} flexShrink={1} minHeight={0}>
          <For each={props.lines}>
            {(line) => <text fg="#8b949e" wrapMode="none">{line}</text>}
          </For>
        </scrollbox>
      </Show>
    </box>
  );
}
