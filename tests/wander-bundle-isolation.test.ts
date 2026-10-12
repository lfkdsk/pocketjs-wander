import { describe, expect, test } from "bun:test";

const APPS = ["wander", "wander-online"] as const;
const BATTLE_MODULE_DIRS = ["/src/rpgmaker-battle/", "/src/ui/rpgmaker-battle/"] as const;
const OPTIONAL_IMPLEMENTATION_PATHS = [
  "/src/engine/rpgmaker-screen.ts",
  "/src/engine/rpgmaker-text.ts",
  "/src/engine/travel-session.ts",
  "/src/engine/travel.ts",
  "/src/ui/ChoiceColourLine.tsx",
  "/src/ui/TravelActors.tsx",
  "/src/ui/choice-colour.ts",
  "/src/ui/travel-actors.ts",
] as const;
const BATTLE_BUNDLE_NEEDLES = [
  "rpgmaker-battle-state/v1",
  "rpgmaker-battle-scene",
  "Math.max(0, a.atk * 4 - b.def * 2)",
] as const;

describe("optional RPG Maker capability bundle isolation", () => {
  for (const app of APPS) {
    test(`${app} excludes optional battle, text, screen, choice and travel implementations`, async () => {
      const inputsPath = new URL(`../dist/${app}.inputs.json`, import.meta.url);
      const bundlePath = new URL(`../dist/${app}.js`, import.meta.url);
      if (!(await Bun.file(inputsPath).exists()) || !(await Bun.file(bundlePath).exists())) {
        throw new Error(`missing built ${app} artifacts; run \`bun run build\``);
      }

      const inputs = await Bun.file(inputsPath).json() as unknown[];
      const normalized = inputs.map((entry) => String(entry).replaceAll("\\", "/"));
      const optionalModules = normalized.filter((entry) =>
        BATTLE_MODULE_DIRS.some((directory) => entry.includes(directory)) ||
        OPTIONAL_IMPLEMENTATION_PATHS.some((path) => entry.includes(path))
      );
      const bundle = await Bun.file(bundlePath).text();
      const optionalNeedles = [
        ...OPTIONAL_IMPLEMENTATION_PATHS.map((path) => path.slice(1)),
        ...BATTLE_BUNDLE_NEEDLES,
      ].filter((needle) => bundle.includes(needle));

      expect(optionalModules).toEqual([]);
      expect(optionalNeedles).toEqual([]);
    });
  }
});
