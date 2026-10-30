import { test, expect } from "bun:test";
import { parseLinkSpec, resolveLinks } from "../src/links";

const SPECS = [
  "apartx-cabinet:apartx-server:env:SERVER_URL",
  "apartx-cabinet:apartx-server:settings:public.serverUrl",
  "apartx-admin:apartx-server:env:SERVER_URL",
  "apartx-server:apartx-cabinet:env:CABINET_URL",
  "apartx-server:apartx-spaces:env:SPACES_HOST",
  "apartx-spaces:apartx-cabinet:env:CABINET_HOST",
  "apartx-spaces:apartx-cabinet:env:CABINET_API_HOST",
];

test("parseLinkSpec splits consumer:target:mechanism:key", () => {
  expect(parseLinkSpec("apartx-cabinet:apartx-server:settings:public.serverUrl")).toEqual({
    consumer: "apartx-cabinet",
    target: "apartx-server",
    mechanism: "settings",
    key: "public.serverUrl",
  });
});

test("resolveLinks returns this consumer's upstreams", () => {
  expect(resolveLinks(SPECS, "apartx-cabinet")).toEqual([
    { consumer: "apartx-cabinet", target: "apartx-server", mechanism: "env", key: "SERVER_URL" },
    { consumer: "apartx-cabinet", target: "apartx-server", mechanism: "settings", key: "public.serverUrl" },
  ]);
});

test("resolveLinks empty for consumer with no upstreams", () => {
  expect(resolveLinks(SPECS, "apartx-pdf")).toEqual([]);
});
