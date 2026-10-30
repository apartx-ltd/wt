import { PLUGIN_API_VERSION, mongoDirectConnectionFilter, type StackPlugin } from "@wt/core/plugin";

/**
 * Generic Node plugin (дефолт для bare-репо): `npm install` / `npm run dev -- --port <port>`.
 * Inline env-инъекция (ядро наслаивает .env/.env.worktree), без isolated-db.
 *
 * `docker()` описывает контейнерную раскладку для проектов, объявивших `docker: {image}`
 * в wt.config: репо монтируется в /opt/app, node_modules живёт в именованном томе (иначе
 * host'овые бинарники под macOS не совпадут с linux-контейнером). Никаких meteor-томов —
 * это чистый node-стек. Для host-режима блок не используется.
 *
 * Флаг прослушивания внешнего интерфейса (`--host` у vite и т.п.) сюда НЕ добавляется:
 * он не универсален для node-стека. Проект, который поднимается в контейнере, объявляет
 * это сам (например `server.host` в vite.config).
 */
export const nodePlugin: StackPlugin = {
  name: "node",
  apiVersion: PLUGIN_API_VERSION,
  envInjection: "inline",
  install: () => ({ argv: ["npm", "install"] }),
  artifactDirs: ["node_modules"],
  devCommand: (ctx) => ({ argv: ["npm", "run", "dev", "--", "--port", String(ctx.port)] }),
  docker: (ctx) => ({
    mounts: [
      `${ctx.worktreeDir}:/opt/app`,
      `${ctx.container}-node_modules:/opt/app/node_modules`,
    ],
    addHosts: ["host.docker.internal:host-gateway"],
    ownedVolumes: [`${ctx.container}-node_modules`],
    envLineFilter: mongoDirectConnectionFilter,
  }),
};

export default nodePlugin;
