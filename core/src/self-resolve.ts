import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { packageRoot } from "./orch";

let registered = false;

/**
 * Установленный глобально wt грузит `wt.config.ts` потребителя, у которого нет `node_modules`:
 * голый `import … from "@apartx/wt"` там не резолвится. Регистрирует в рантайме Bun
 * виртуальные модули `@apartx/wt` и его подпути — по карте `exports` корневого
 * `package.json` (читается на лету, резолвер не расходится с `exports`); каждый отдаёт
 * namespace настоящего файла пакета (тот же инстанс модуля, грузится лениво при первом
 * импорте). Перекрывает и `@apartx/wt` из `node_modules` потребителя — конфиг видит ту
 * версию wt, что его исполняет. Неизвестный подпуть — штатное «Cannot find module».
 *
 * Именно `build.module`, а не `build.onResolve`: в Bun 1.3 runtime-`onResolve` не
 * вызывается для голых спецификаторов, которых нет в `node_modules`.
 * Идемпотентно: регистрируется один раз на процесс.
 */
export function registerSelfResolver(root = packageRoot()): void {
  if (registered) return;
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, string>;
  };
  Bun.plugin({
    name: "@apartx/wt self-resolve",
    setup(build) {
      for (const [subpath, file] of Object.entries(pkg.exports)) {
        const target = resolve(root, file);
        build.module(pkg.name + subpath.slice(1), () => ({
          // JSON через require — сам объект; у модуля-объекта он становится default-экспортом.
          exports: target.endsWith(".json") ? { default: require(target) } : require(target),
          loader: "object",
        }));
      }
    },
  });
  registered = true;
}
