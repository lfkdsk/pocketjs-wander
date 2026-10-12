import { describe, expect, test } from "bun:test";

const APPS = ["wander", "wander-online"] as const;
const BATTLE_MODULE_DIRS = ["/src/rpgmaker-battle/", "/src/ui/rpgmaker-battle/"] as const;
const BATTLE_BUNDLE_NEEDLES = [
  "rpgmaker-battle-state/v1",
  "rpgmaker-battle-scene",
  "Math.max(0, a.atk * 4 - b.def * 2)",
] as const;

describe("optional RPG Maker battle bundle isolation", () => {
  for (const app of APPS) {
    test(`${app} does not bundle the optional battle rules or UI`, async () => {
      const inputsPath = new URL(`../dist/${app}.inputs.json`, import.meta.url);
      const bundlePath = new URL(`../dist/${app}.js`, import.meta.url);
      if (!(await Bun.file(inputsPath).exists()) || !(await Bun.file(bundlePath).exists())) {
        throw new Error(`missing built ${app} artifacts; run \`bun run build\``);
      }

      const inputs = await Bun.file(inputsPath).json() as unknown[];
      const normalized = inputs.map((entry) => String(entry).replaceAll("\\", "/"));
      const battleModules = normalized.filter((entry) =>
        BATTLE_MODULE_DIRS.some((directory) => entry.includes(directory))
      );
      const bundle = await Bun.file(bundlePath).text();
      const battleNeedles = BATTLE_BUNDLE_NEEDLES.filter((needle) => bundle.includes(needle));

      expect(battleModules).toEqual([]);
      expect(battleNeedles).toEqual([]);
    });
  }
});
