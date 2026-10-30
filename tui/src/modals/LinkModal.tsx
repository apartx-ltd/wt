import { onMount } from "solid-js";
import type { InputRenderable } from "@opentui/core";
import { Modal } from "../Modal";

/**
 * Link a worktree's upstreams to a same-slug mesh (`wt link [link-slug]`). Typing/
 * editing is handled natively by the focused `<input>`, Enter submits via on:enter
 * (payload = current value), Esc cancels (handled in App's modal keyboard branch).
 *
 * Focus is deferred to the next tick rather than set on mount: the key that opens
 * the modal ('l') is still being routed when the input mounts, and focusing
 * synchronously makes that same key get typed into the input ("feat-a" → "feat-al").
 */
export function LinkModal(props: {
  project: string;
  slug: string;
  defaultLink: string;
  onSubmit: (linkSlug: string) => void;
}) {
  let input: InputRenderable | undefined;
  onMount(() => setTimeout(() => input?.focus(), 0));

  return (
    <Modal title="Link worktree">
      <text fg="#c9d1d9">{`${props.project} / ${props.slug}`}</text>
      <text fg="#8b949e">{"link upstreams to slug:"}</text>
      <input
        ref={(el: InputRenderable) => (input = el)}
        value={props.defaultLink}
        width={32}
        backgroundColor="#0d1117"
        on:enter={(v: string) => props.onSubmit(v)}
      />
      <text fg="#6e7681">{"(Enter) link   (Esc) cancel"}</text>
    </Modal>
  );
}
