import { createSignal } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import type { InputRenderable } from "@opentui/core";
import { Modal } from "../Modal";

const ACTIVE = "#58a6ff";
const DIM = "#8b949e";
const FAINT = "#6e7681";

export interface NewWorktreeArgs {
  project: string;
  slug: string;
  isolatedDb: boolean;
  seed: boolean;
}

/**
 * Create-worktree form. Self-contained keyboard: App's handler returns early for
 * this modal so the two never fight. Navigation/edit split avoids the classic
 * "focused input eats Tab/arrows" problem — ↑/↓ move between fields with nothing
 * natively focused; the slug <input> is focused ONLY in edit mode (entered with
 * Enter on the slug field), where typing/editing is native and Enter/Esc exits.
 *
 * Fields: 0 project (←/→), 1 slug (Enter→edit), 2 --isolated-db (Space), 3 --seed
 * (Space), 4 Create (Enter).
 */
export function NewWorktreeModal(props: {
  projects: string[];
  onSubmit: (args: NewWorktreeArgs) => void;
  onCancel: () => void;
}) {
  const [field, setField] = createSignal(0);
  const [projectIdx, setProjectIdx] = createSignal(0);
  const [isoDb, setIsoDb] = createSignal(false);
  const [seed, setSeed] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  let input: InputRenderable | undefined;

  const submit = () => {
    const slug = (input?.value ?? "").trim();
    if (!slug) return; // require a slug
    props.onSubmit({ project: props.projects[projectIdx()], slug, isolatedDb: isoDb(), seed: seed() });
  };

  useKeyboard((key) => {
    const n = key.name;
    if (editing()) {
      // Native input owns typing; Enter/Esc leave edit mode.
      if (n === "return" || n === "escape") setEditing(false);
      return;
    }
    if (n === "escape") return props.onCancel();
    if (n === "up") return setField((f) => Math.max(0, f - 1));
    if (n === "down" || n === "tab") return setField((f) => (f + 1) % 5);
    const f = field();
    if (f === 0) {
      if (n === "left") setProjectIdx((i) => Math.max(0, i - 1));
      else if (n === "right") setProjectIdx((i) => Math.min(props.projects.length - 1, i + 1));
    } else if (f === 1) {
      if (n === "return") setEditing(true);
    } else if (f === 2) {
      if (n === "space" || n === " ") setIsoDb((v) => !v);
    } else if (f === 3) {
      if (n === "space" || n === " ") setSeed((v) => !v);
    } else if (f === 4) {
      if (n === "return") submit();
    }
  });

  const mark = (i: number) => (field() === i ? "▸" : " ");
  const rowFg = (i: number) => (field() === i ? ACTIVE : DIM);

  return (
    <Modal title="New worktree">
      <text fg={rowFg(0)} wrapMode="none">
        {`${mark(0)} project:  ${props.projects[projectIdx()] ?? "—"}   (←/→)`}
      </text>
      <box flexDirection="row">
        <text fg={rowFg(1)} wrapMode="none">{`${mark(1)} slug:     `}</text>
        <input ref={(el: InputRenderable) => (input = el)} value="" focused={editing()} width={24} backgroundColor="#0d1117" />
        <text fg={FAINT} wrapMode="none">{editing() ? "  (Enter ok)" : "  (Enter edit)"}</text>
      </box>
      <text fg={rowFg(2)} wrapMode="none">{`${mark(2)} [${isoDb() ? "x" : " "}] --isolated-db`}</text>
      <text fg={rowFg(3)} wrapMode="none">{`${mark(3)} [${seed() ? "x" : " "}] --seed`}</text>
      <text fg={rowFg(4)} wrapMode="none">{`${mark(4)} Create`}</text>
      <text fg={FAINT} wrapMode="none">{"↑/↓ field  ←/→ project  Space toggle  Enter edit/create  Esc cancel"}</text>
    </Modal>
  );
}
