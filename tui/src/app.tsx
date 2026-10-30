import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { HttpWtClient, type MergedInstance } from "@wt/shared";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { InstanceList } from "./InstanceList";
import { LogPane } from "./LogPane";
import { ConfirmRm } from "./modals/ConfirmRm";
import { LinkModal } from "./modals/LinkModal";
import { NewWorktreeModal, type NewWorktreeArgs } from "./modals/NewWorktreeModal";
import { resolveKey, resolveConfirm, type Action } from "./keymap";

type ModalState =
  | { kind: "rm"; project: string; slug: string }
  | { kind: "link"; project: string; slug: string; defaultLink: string }
  | { kind: "new"; projects: string[] };

export function App(props: { client: HttpWtClient }) {
  const renderer = useRenderer();
  const [instances, setInstances] = createSignal<MergedInstance[]>([]);
  // Selection is tracked by identity (project/slug), NOT array index: the instance
  // list reorders and gains/loses rows every ~1.5s poll (the alive-probe flaps), so
  // a raw index silently drifts onto a different branch each refresh — which kept
  // tearing down and re-subscribing the log stream so logs never accumulated.
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const [logLines, setLogLines] = createSignal<string[]>([]);
  const [actionMsg, setActionMsg] = createSignal<string | null>(null);
  const [modal, setModal] = createSignal<ModalState | null>(null);
  const [title, setTitle] = createSignal("worktrees");

  const refresh = () => props.client.listInstances().then(setInstances).catch(() => {});

  const keyOf = (i: MergedInstance) => `${i.project}/${i.slug}`;
  // Resolve the selected row's index from its identity; fall back to row 0 if the
  // chosen instance isn't in the current list (e.g. it briefly dropped out).
  const selectedIndex = createMemo(() => {
    const list = instances();
    if (list.length === 0) return -1;
    const k = selectedKey();
    const idx = k ? list.findIndex((i) => keyOf(i) === k) : -1;
    return idx >= 0 ? idx : 0;
  });
  const current = () => instances()[selectedIndex()];
  const currentKey = createMemo(() => {
    const c = current();
    return c ? keyOf(c) : "";
  });
  // The log-follow target: the SELECTED key (not current(), which falls back to row 0
  // when the selection is transiently absent). Returns the key once that instance is
  // confirmed up; otherwise latches — if we were already following it (prev === k) we
  // keep the stream alive through a one-poll probe flap (absent or flipped to "down"),
  // so a flaky probe can't tear down a working `wt logs -f`. Only a real selection
  // change or an instance first coming up flips it (and triggers re-subscribe).
  const followKey = createMemo<string | null>((prev) => {
    const k = selectedKey();
    if (!k) return null;
    const inst = instances().find((i) => keyOf(i) === k);
    if (inst?.status === "up") return k;
    return prev === k ? prev : null;
  }, null);

  // Move the cursor by identity: resolve the neighbour in the current list and pin
  // its key, so the selection survives the next reorder.
  const move = (delta: number) => {
    const list = instances();
    if (list.length === 0) return;
    const next = Math.min(Math.max(selectedIndex() + delta, 0), list.length - 1);
    setSelectedKey(keyOf(list[next]));
  };

  // Seed selectedKey on first load only. We deliberately do NOT re-pin when the
  // selected key goes missing: a flaky poll that drops a row would otherwise yank the
  // selection (and the log stream) onto a different branch. selectedIndex falls back
  // to row 0 for the cursor while absent; followKey latches so the stream survives,
  // and the selection re-resolves the moment the instance reappears.
  createEffect(() => {
    const list = instances();
    if (list.length > 0 && selectedKey() === null) setSelectedKey(keyOf(list[0]));
  });

  // Restore the terminal (alt-screen / raw mode) before exiting.
  const quit = () => {
    renderer.destroy();
    process.exit(0);
  };

  const act = (action: Action) => {
    const c = current();
    if (!c) return;
    const { project, slug } = c;
    if (action === "start") {
      setActionMsg(`starting ${slug} …`);
      props.client.start(project, slug).catch((e) => setActionMsg(String(e)));
    } else if (action === "restart") {
      setActionMsg(`restarting ${slug} …`);
      props.client.restart(project, slug).catch((e) => setActionMsg(String(e)));
    } else if (action === "stop") {
      setActionMsg(`stopping ${slug} …`);
      props.client
        .stop(project, slug)
        .then((r) => setActionMsg(r.code === 0 ? `stopped ${slug}` : `stop failed: ${r.stderr ?? r.code}`))
        .catch((e) => setActionMsg(String(e)));
    }
  };

  // Register the keyboard handler FIRST. useKeyboard attaches its listener in an
  // onMount, and Solid aborts the remaining mount queue if an earlier onMount
  // throws. Keeping this before the data-loading onMount guarantees input stays
  // alive even if data loading fails on mount — exactly what bit us when the
  // EventSource-based subscribe() threw and silently killed keyboard input.
  // Run a quick mutation that returns an exit code, with a status toast + refresh.
  const runCoded = (verb: string, slug: string, p: Promise<{ code: number; stderr?: string }>) => {
    setActionMsg(`${verb} ${slug} …`);
    p.then((r) => setActionMsg(r.code === 0 ? `${verb} ${slug} ✓` : `${verb} failed: ${r.stderr ?? r.code}`))
      .catch((e) => setActionMsg(String(e)))
      .finally(refresh);
  };

  const confirmRm = (m: { project: string; slug: string }, dropBranch: boolean) => {
    setModal(null);
    runCoded("removing", m.slug, props.client.rmWorktree(m.project, m.slug, dropBranch));
  };

  const doLink = (m: { project: string; slug: string }, linkSlug: string) => {
    setModal(null);
    const arg = linkSlug.trim();
    runCoded("linking", m.slug, props.client.link(m.project, m.slug, arg && arg !== m.slug ? arg : undefined));
  };

  // `wt new` runs detached (build takes minutes) → 202, no exit code to await.
  const doNew = (a: NewWorktreeArgs) => {
    setModal(null);
    setActionMsg(`creating ${a.project}/${a.slug} …`);
    props.client
      .newWorktree({ project: a.project, slug: a.slug, isolatedDb: a.isolatedDb, seed: a.seed })
      .then(() => setActionMsg(`creating ${a.project}/${a.slug} (background)`))
      .catch((e) => setActionMsg(String(e)));
  };

  const openNew = () => {
    props.client
      .listProjects()
      .then((projects) => {
        if (projects.length === 0) setActionMsg("no projects found");
        else setModal({ kind: "new", projects });
      })
      .catch((e) => setActionMsg(String(e)));
  };

  useKeyboard((key) => {
    // When a modal is open, route keys to it and suspend the dashboard keymap.
    const m = modal();
    if (m) {
      if (m.kind === "rm") {
        const c = resolveConfirm(key.name);
        if (c === "cancel") setModal(null);
        else if (c === "confirm") confirmRm(m, false);
        else if (c === "confirmBranch") confirmRm(m, true);
      } else if (m.kind === "link") {
        // The focused <input> handles text + Enter (on:enter); we only cancel.
        if (key.name === "escape") setModal(null);
      }
      // kind "new": NewWorktreeModal owns its own keyboard handler — leave it be.
      return;
    }
    const action = resolveKey(key.name, { ctrl: key.ctrl });
    if (action === "quit") quit();
    else if (action === "down") move(1);
    else if (action === "up") move(-1);
    else if (action === "start" || action === "stop" || action === "restart") act(action);
    else if (action === "rm") {
      const c = current();
      if (!c) return;
      if (c.slug === "base") setActionMsg("can't rm the base checkout (slug 'base')"); // BASE_SLUG
      else setModal({ kind: "rm", project: c.project, slug: c.slug });
    } else if (action === "link") {
      const c = current();
      if (c) setModal({ kind: "link", project: c.project, slug: c.slug, defaultLink: c.slug });
    } else if (action === "unlink") {
      const c = current();
      if (c) runCoded("unlinking", c.slug, props.client.unlink(c.project, c.slug));
    } else if (action === "new") {
      openNew();
    }
  });

  // Follow the selected instance's logs. followKey is the sole, value-stable trigger:
  // it only changes on a real selection change or when the instance first comes up,
  // so the ~1.5s poll (and its probe flaps) can't churn the subscription. A null key
  // (nothing selected, or selected-and-down) shows an empty pane until it comes up.
  createEffect(() => {
    const k = followKey();
    setLogLines([]);
    if (!k) return;
    const slash = k.indexOf("/");
    const project = k.slice(0, slash);
    const slug = k.slice(slash + 1);
    const unsub = props.client.streamLogs(project, slug, (line) =>
      setLogLines((l) => [...l, line].slice(-200)),
    );
    onCleanup(unsub);
  });

  onMount(() => {
    // opentui renders ON DEMAND by default: it only flushes a frame on input or a
    // reconciler request, NOT when a signal changes from an async callback or timer.
    // Our live data (log follow + the instance/uptime poll) arrives on async SSE
    // callbacks, so without this the screen only repaints when a key is pressed —
    // the log pane looked frozen and the list only "streamed" because navigation
    // happened to trigger paints. requestLive() holds the renderer in its continuous
    // loop (the same mechanism timelines use while animating) for the dashboard's
    // lifetime, so every async update paints. dropLive() restores on-demand on unmount.
    renderer.requestLive();
    props.client.listInstances().then(setInstances).catch(() => {});
    props.client.getMeta().then((m) => { if (m.title) setTitle(m.title); }).catch(() => {});
    // Guard the subscription: a failure here must never poison the mount queue.
    let unsub = () => {};
    try {
      unsub = props.client.subscribe((e) => {
        if (e.type === "instances") setInstances(e.instances);
      });
    } catch {
      /* live updates unavailable; the initial listInstances() still populated the UI */
    }
    const clock = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    // Poll the instance list as a fallback to the SSE stream. streamSse swallows
    // connect/transport errors and never reconnects, so if the events stream failed to
    // establish or dropped (e.g. an instance was started after mount), the list would
    // otherwise freeze on the initial snapshot — and the log follow, gated on a row
    // being "up", would never start. A cheap GET every couple seconds self-heals both.
    const poll = setInterval(() => void refresh(), 2000);
    onCleanup(() => {
      unsub();
      clearInterval(clock);
      clearInterval(poll);
      renderer.dropLive();
    });
  });

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1} borderStyle="rounded">
      <text flexShrink={0} fg="#58a6ff">{`wt · ${title()}`}</text>
      {/* The list and log pane each own a scrollbox; they share the flexible space
          (list weighted 2:1) so the footer/log can never be pushed off-screen. */}
      <InstanceList instances={instances()} selected={selectedIndex()} now={now()} onScroll={move} />
      <LogPane title={currentKey() || "—"} lines={logLines()} />
      {actionMsg() && <text flexShrink={0} fg="#d29922">{actionMsg()}</text>}
      <text flexShrink={0} fg="#6e7681">
        {"↑/↓ nav  s start  x stop  r restart  n new  d rm  l link  u unlink   Esc/q quit"}
      </text>
      <Show when={modal()} keyed>
        {(m) =>
          m.kind === "rm" ? (
            <ConfirmRm project={m.project} slug={m.slug} />
          ) : m.kind === "link" ? (
            <LinkModal
              project={m.project}
              slug={m.slug}
              defaultLink={m.defaultLink}
              onSubmit={(v) => doLink(m, v)}
            />
          ) : (
            <NewWorktreeModal projects={m.projects} onSubmit={doNew} onCancel={() => setModal(null)} />
          )
        }
      </Show>
    </box>
  );
}
