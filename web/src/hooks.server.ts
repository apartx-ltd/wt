import type { Handle } from "@sveltejs/kit";

/**
 * Inject the theme class on `<html>` server-side so the correct palette paints
 * on first byte (no FOUC). The client flips the class + cookie afterwards.
 * Mirrors the apartx-help / apartx-admin SSR theme approach.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const theme = event.cookies.get("theme") === "dark" ? "dark" : "light";
  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace("%theme%", theme),
  });
};
