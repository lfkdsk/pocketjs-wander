# Asset attribution — pocketjs-wander

The wander world draws the rule-grown settlement's committed PNGs in
`vendor/pocket-rpgkit/examples/grow/assets/`, referenced in place (the build
resolves `../../vendor/pocket-rpgkit/examples/grow/assets/<file>.png`
against `examples/wander/`), plus composites of those same PNGs and its own
character look pool (sixteen Ninja Adventure walkers in four build-time
palettes). All art is CC0 or CC-BY; no RPG Maker or other commercial game
assets are included. The full provenance of the grow art — terrain recipes,
stamp compositions and the tileset packs — is in
`vendor/pocket-rpgkit/examples/grow/ATTRIBUTION.md`.

## Pixel-Boy and AAA — Ninja Adventure (terrain, trees, houses, characters)

- Used through `vendor/pocket-rpgkit/examples/grow/assets/grow-*.png`
  (terrain fills, seams, ground and upper cells, stamp cells, the villager)
  and through `examples/wander/assets/src/ninja-adventure/walk/*.png`
  (sixteen character Walk sheets: Villager, Villager2..4, Boy, Woman,
  ManGreen, OldMan, OldMan2, Monk, Monk2, Hunter, Eskimo, Noble, Samurai,
  SamuraiBlue), which `gen-assets.ts` slices into the look pool's walker
  frames.
- Source: https://pixel-boy.itch.io/ninja-adventure-asset-pack and
  https://github.com/pixel-boy/NinjaAdventure. The Walk sheets ship in the
  pack's `Actor/Characters/<Name>/SeparateAnim/Walk.png`; the sixteen here
  were taken from a public project that vendors the unmodified pack
  (https://github.com/MarioLDD/Kuroshiro-adventure,
  `Assets/NinjaAdventure/Actor/Characters/`), the same provenance grow's
  full-pack tilesets use.
- License: **CC0 1.0 Universal**,
  https://creativecommons.org/publicdomain/zero/1.0/legalcode.
  Credit is not required by CC0 but is given: **Ninja Adventure Asset Pack
  — Pixel-Boy and AAA**.

## Lanea Zimmerman (Sharm) — Tiny 16 basic character set (alternate player)

- Used through `vendor/pocket-rpgkit/examples/grow/assets/player-dir0..3.png`
  and `player-pose{0..3}-{l,r}.png` (unaltered 16x16 crops of the "Tiny 16"
  walker atlases). Kept as an alternate player look
  (`__wanderPlayerLook = "tiny16"`); the default player look comes from the
  Ninja Adventure pool.
- Source: https://opengameart.org/content/tiny-16-basic
  (Lanea Zimmerman, "Tiny 16", via OpenGameArt.org).
- License: **CC-BY 3.0**, https://creativecommons.org/licenses/by/3.0/legalcode.
- Required credit: **Lanea Zimmerman (Sharm), "Tiny 16"**, via
  OpenGameArt.org.

## Generated in this repository

- `examples/wander/assets/stamp-*.png` — each multi-cell Ninja stamp of
  grow's stamp list (trees, boulders, palms, market stalls, houses)
  composited from grow's own 16x16 stamp cells into one image, padded with
  transparent pixels to a power-of-two size. Derived from CC0 art; dedicated
  under **CC0 1.0**.
- `examples/wander/assets/fill64-*.png` — 4x4 tiles of grow's biome fill
  cells (grow's original CC0 pixel recipes); **CC0 1.0**.
- `examples/wander/assets/look/tilesets/b*.pkts` — the character look pool:
  16 Ninja Adventure walkers x 4 palettes = 64 looks, each 12 walker frames
  (idle/step-L/step-R x down/left/up/right) sliced from the pack's 4x4
  Walk.png and palette-replaced (garment and hair indices only), cooked to
  one CLUT8 TILESET blob per base. The per-frame pixels are generated in
  memory by `examples/wander/look-assets.ts` (a pure function of
  base/palette/pose/facing); no per-frame PNGs are committed. Derived from
  CC0 art; dedicated under **CC0 1.0**.
- All of the above are written by `examples/wander/gen-assets.ts`, which
  reproduces them byte for byte from the source PNGs.
- `tests/goldens/wander.*.png` — frames rendered by the PocketJS wasm sim
  from the assets above; the same licenses apply.
