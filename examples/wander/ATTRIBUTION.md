# Asset attribution — endless wander

The wander example ships no art of its own sources: every image it draws
is one of the rule-grown settlement's committed PNGs in
`examples/grow/assets/`, referenced in place (the build resolves
`../grow/assets/<file>.png` against this directory), plus a few
composites of those same PNGs. All art is CC0 or CC-BY; no RPG Maker or
other commercial game assets are included. The full provenance of the
grow art is in `examples/grow/ATTRIBUTION.md`.

## Pixel-Boy and AAA — Ninja Adventure (terrain, trees, houses, villagers)

- Used through `examples/grow/assets/grow-*.png` (terrain fills, seams,
  ground and upper cells, stamp cells, the villager).
- Source: https://pixel-boy.itch.io/ninja-adventure-asset-pack and
  https://github.com/pixel-boy/NinjaAdventure.
- License: **CC0 1.0 Universal**,
  https://creativecommons.org/publicdomain/zero/1.0/legalcode.
  Credit is not required by CC0 but is given: **Ninja Adventure Asset Pack
  — Pixel-Boy and AAA**.

## Lanea Zimmerman (Sharm) — Tiny 16 basic character set (player)

- Used through `examples/grow/assets/player-dir0..3.png` and
  `player-pose{0..3}-{l,r}.png` (unaltered 16×16 crops of the "Tiny 16"
  walker atlases).
- Source: https://opengameart.org/content/tiny-16-basic
  (Lanea Zimmerman, "Tiny 16", via OpenGameArt.org).
- License: **CC-BY 3.0**, https://creativecommons.org/licenses/by/3.0/legalcode.
- Required credit: **Lanea Zimmerman (Sharm), "Tiny 16"**, via
  OpenGameArt.org.

## Generated in this repository

- `examples/wander/assets/stamp-*.png` — each multi-cell Ninja stamp of
  `examples/grow/grow-stamps.ts` (trees, boulders, palms, market stalls,
  houses) composited from grow's own 16×16 stamp cells into one image,
  padded with transparent pixels to a power-of-two size. Derived from CC0
  art; dedicated under **CC0 1.0**.
- `examples/wander/assets/fill64-*.png` — 4×4 tiles of grow's biome fill
  cells (grow's original CC0 pixel recipes in `grow-art.ts`); **CC0 1.0**.
- Both are written by `examples/wander/gen-assets.ts`, which reproduces them
  byte for byte from the grow PNGs.
- `tests/goldens/wander.*.png` — frames rendered by the PocketJS wasm sim
  from the assets above; the same licenses apply.
