import type { JSX } from "solid-js";

/**
 * Full-screen absolute overlay that centers its content box on top of the
 * dashboard (high zIndex). Presentational only — key handling lives in App's
 * single useKeyboard, branched on which modal is open (so input can never be
 * silently dropped, the lesson from the keyboard-mount bug).
 */
export function Modal(props: { title: string; children: JSX.Element }) {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      justifyContent="center"
      alignItems="center"
    >
      <box flexDirection="column" borderStyle="rounded" padding={1} backgroundColor="#161b22">
        <text fg="#58a6ff">{props.title}</text>
        {props.children}
      </box>
    </box>
  );
}
