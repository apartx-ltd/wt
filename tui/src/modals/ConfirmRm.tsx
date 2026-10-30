import { Modal } from "../Modal";

/**
 * Confirm removal of a worktree. No text input — just y / b / n, so it reuses the
 * working keymap pattern (resolveConfirm) routed from App's keyboard handler.
 */
export function ConfirmRm(props: { project: string; slug: string }) {
  return (
    <Modal title="Remove worktree?">
      <text fg="#c9d1d9">{`${props.project} / ${props.slug}`}</text>
      <text fg="#8b949e">{"This stops the instance and removes the worktree."}</text>
      <text fg="#6e7681">{"(y) remove   (b) remove + delete branch   (n/Esc) cancel"}</text>
    </Modal>
  );
}
