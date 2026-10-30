<script lang="ts">
  import { onMount } from "svelte";
  import { Page, Header, Toolbar, Title, Content } from "apartx-ui/structure";
  import { List, Item, ListHeader } from "apartx-ui/data";
  import { Loading } from "apartx-ui/display";
  import type { MergedInstance, RunStatus, WtEvent } from "@wt/shared";
  import { sections } from "@wt/shared";
  import { getWtClient } from "$lib/wtClient";

  let instances = $state<MergedInstance[]>([]);
  let grouped = $derived(sections(instances));
  let connecting = $state(true);
  let error = $state<string | null>(null);
  let title = $state("worktrees");

  // M3 token per status — green up, grey down, amber building.
  const STATUS_COLOR: Record<RunStatus, string> = {
    up: "var(--theme-success)",
    down: "var(--theme-outline)",
    building: "var(--theme-warning)",
  };

  function uptime(started: number | null): string {
    if (!started) return "";
    const s = Math.max(0, Math.floor(Date.now() / 1000) - started);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  }

  onMount(() => {
    const c = getWtClient();
    c.getMeta().then((m) => { if (m.title) title = m.title; }).catch(() => {});
    c.listInstances()
      .then((i) => (instances = i))
      .catch((e) => (error = String(e)))
      .finally(() => (connecting = false));

    let unsub = () => {};
    try {
      unsub = c.subscribe((e: WtEvent) => {
        if (e.type === "instances") instances = e.instances;
        else if (e.type === "error") error = e.message;
      });
    } catch {
      /* live updates unavailable; the initial list still populated the view */
    }
    return () => unsub();
  });
</script>

<Page>
  <Header>
    <Toolbar>
      <Title>{`wt · ${title}`}</Title>
    </Toolbar>
  </Header>
  <Content>
    {#if connecting}
      <div class="flex items-center gap-3 p-4 text-on-surface-variant">
        <Loading /> connecting…
      </div>
    {:else if error}
      <div class="m-4 rounded-lg bg-error-container p-4 text-on-error-container">
        {error}
      </div>
    {:else if instances.length === 0}
      <div class="p-4 text-on-surface-variant">No instances.</div>
    {:else}
      <List>
        {#each grouped as section (section.key)}
          <ListHeader>{section.label}</ListHeader>
          {#each section.rows as i (i.project + "/" + i.slug)}
            <Item>
              {#snippet start()}
                <span
                  class="inline-block h-2.5 w-2.5 rounded-full"
                  style="background:{STATUS_COLOR[i.status]}"
                  title={i.status}
                ></span>
              {/snippet}
              <div class="flex flex-col">
                <span class="text-body-lg text-on-surface">{i.project} / {i.slug}</span>
                <span class="text-body-sm text-on-surface-variant">{i.branch}</span>
              </div>
              {#snippet end()}
                <div class="flex flex-col items-end text-body-sm text-on-surface-variant">
                  <span>{i.port ?? "—"}</span>
                  <span>{i.status}{i.started ? ` · ${uptime(i.started)}` : ""}</span>
                </div>
              {/snippet}
            </Item>
          {/each}
        {/each}
      </List>
    {/if}
  </Content>
</Page>
