<script lang="ts">
  import "../app.css";
  import { setNavigator, setRouteKey, matchActive } from "apartx-ui/navigation";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  // Adapt SvelteKit routing to the kit's router-agnostic Navigator contract so
  // <Link> and other nav-aware components route through SvelteKit.
  setNavigator({
    push: (href: string) => goto(href),
    replace: (href: string) => goto(href, { replaceState: true }),
    back: () => history.back(),
    get current() {
      return {
        pathname: page.url.pathname,
        search: page.url.search,
        hash: page.url.hash,
      };
    },
    isActive: (href: string, opts?: { exact?: boolean }) =>
      matchActive(page.url.pathname, href, opts),
  });

  setRouteKey(() => page.url.pathname);

  let { children } = $props();
</script>

{@render children()}
