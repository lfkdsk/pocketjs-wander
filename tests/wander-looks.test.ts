// tests/wander-looks.test.ts — the character look pool: stable ids, the
// seed-based look assignment, the build-time palette variants, and parity
// between the pure frame generator and the shipped CLUT8 tilesets.
//
// The numeric look id is a published contract (online profiles and the
// ROSTER will persist it), so the id<->look mapping and the per-villager
// assignment are pinned here. The palette variants and the generated frames
// come from look-assets.ts' pure lookFrameRGBA (no generated per-frame PNGs
// are committed), so a gen-assets change that silently stops recoloring a
// base — or desyncs the shipped tilesets from the generator — fails here.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decodePng } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import {
  TILESET_ABSENT,
  TILESET_DIR_ENTRY_SIZE,
  TILESET_FLAG_RLE,
  TILESET_HEADER_SIZE,
  TILESET_MAGIC,
  TILESET_VERSION,
  packbitsDecode,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";
import {
  LOOK_BASES,
  LOOK_BASE_NAMES,
  LOOK_COUNT,
  LOOK_PALETTES,
  lookFor,
  lookFromId,
  lookId,
  parseVillagerId,
  playerLook,
  type CharacterLook,
} from "../examples/wander/looks.ts";
import { WANDER_LOOKS, WANDER_LOOK_BASES } from "../examples/wander/assets-wander.ts";
import {
  FACING_CH,
  LOOK_PALETTE_COUNT,
  LOOK_POSE_BASE,
  LOOK_TILES_PER_BASE,
  POSES,
  lookFrameRGBA,
  quantizedWords,
} from "../examples/wander/look-assets.ts";

const WALK_SRC_DIR = new URL("../examples/wander/assets/src/ninja-adventure/walk/", import.meta.url);
const TILESET_DIR = new URL("../examples/wander/assets/look/tilesets/", import.meta.url);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sha256File = async (url: URL): Promise<string> =>
  sha256(new Uint8Array(await Bun.file(url).arrayBuffer()));

describe("look pool: ids", () => {
  test("the pool has 16 bases x 4 palettes = 64 looks", () => {
    expect(LOOK_BASES).toBe(16);
    expect(LOOK_PALETTES).toBe(4);
    expect(LOOK_COUNT).toBe(64);
    expect(WANDER_LOOKS).toHaveLength(LOOK_COUNT);
  });

  test("ids are 0..63 in order and round-trip", () => {
    for (let id = 0; id < LOOK_COUNT; id++) {
      const look = lookFromId(id);
      expect(lookId(look)).toBe(id);
      expect(WANDER_LOOKS[id]!.id).toBe(id);
      expect(WANDER_LOOKS[id]!.base).toBe(look.base);
      expect(WANDER_LOOKS[id]!.palette).toBe(look.palette);
    }
  });

  test("id = base * 4 + palette (the published encoding)", () => {
    expect(lookId({ base: 0, palette: 0 })).toBe(0);
    expect(lookId({ base: 0, palette: 3 })).toBe(3);
    expect(lookId({ base: 1, palette: 0 })).toBe(4);
    expect(lookId({ base: 15, palette: 3 })).toBe(63);
  });

  test("lookFromId clamps out-of-range ids to the pool", () => {
    expect(lookId(lookFromId(-1))).toBe(0);
    expect(lookId(lookFromId(999))).toBe(LOOK_COUNT - 1);
  });
});

describe("look pool: base identity (append-only; never reorder or delete)", () => {
  // The numeric id is a published contract, so the review asked for the
  // SEMANTICS of the base index to be pinned, not just the encoding: base i
  // must always be the same character. Each row pins [name, source sheet
  // sha256, generated palette-0 idle-down frame sha256]. The source hash
  // pins which sheet the name means; the generated hash pins that
  // gen-assets.ts actually baked base i from that sheet (swapping two bases
  // in gen-assets' LOOK_BASES repoints the generated art and fails here).
  // APPEND-ONLY: add rows at the end, never reorder or delete.
  const PINNED: readonly (readonly [(typeof LOOK_BASE_NAMES)[number], string, string])[] = [
    ["Villager", "4d4e811da1630bda1b2d1b97e29872a5188ec86899cfb166683fc24f4556de21", "3cfc67c99eb05a6a7e02f3248c628668d317a5fb66e6f5dbdc0376e42e9b8b2c"],
    ["Villager2", "497c64ae14f4aec10bde51d37fa8a7d050d59a8712470e8f8183c0594574b4d5", "85ce88147d77fe75a8b3d2e2cb366b348c31c8958414d75d75c5e552672205e0"],
    ["Villager3", "c1f4af9fba85061924eae6eade7e4343115e52eaff7f229e8f7a5a73672e72c2", "4ff89a073d0e752ffdf3da1b08e4435e78b8f78de3e4f5ef3116e2a12d49cede"],
    ["Villager4", "8f8f7a89910081748095da91792f9965a18494583bcc054a22bc259741849c5a", "cf1abe3365c1c94f5ceb72198c33fd61c1eea9afaa60f7495af327f94cee1be8"],
    ["Boy", "9fdf3697e86005c64103805db9edc4a949d7d4aa6626c50f8d91d3ee916a3de2", "f0f0c74f2edec874b47b133f5cc12ef0e6c438e4d4b9118dff7bd868f20b4c08"],
    ["Woman", "436143d8d7c751615d252f4a42a29c7620fbece546d296b5b86ae19fff20d241", "99df20d568ca0a29b38a5e9ce2a4dd1e7dd0c28e58a9c9e38d867cdd9ab0b309"],
    ["ManGreen", "25480e315c64552cd2b019c337a968ac5d0377f3a3d6076ed9a34e6f2edf6470", "2f5c725cd9dc284633096076db7a67913ccb91019da5ca6d5c305b92a077ae3b"],
    ["OldMan", "548e3e38992d8efd49b2902ed3091a35b2a88ad9e491d9300fd235ce91846d00", "31efb178179c22fcc13273db76052edbfbb7f505188aace3b351cdef3e42cda4"],
    ["OldMan2", "7f932bea28f460caa7ec128372dcefee8197c755595d40910438d0a0f200dab4", "44fb5070ad27c9bdb2b56129dcde6235abce6e0ccd1711ee90137431fb1aef5d"],
    ["Monk", "55ccc341cb6bb97d4ed13972b430eddf1b614b33f0e9bbd422d7b8ff781525f9", "0b065168a91c2559fbe2ff3d497beb57f835f03341becc8097aec01284d2ec91"],
    ["Monk2", "ad130de9b0b891c7afc4838ca05903893b8fd54069d698b11ff8947d178c6c14", "806b39b158e855f1d23f7d345fa80b820cf9aa75d2a8aa6b3f339d9b3726d167"],
    ["Hunter", "f24ec72534ef2418f1e2027376c2f571657883861bedaeeb18ec2b7710cf6a90", "47d8e49c43703f919566be0cec3dbe69963433be9e63f20e9c0c68fe37fc66b7"],
    ["Eskimo", "bed0edf3a11d5f6ee087d6b939f04a248400a6faa42be4202594f8bb0cb43f2d", "9936ddaf9042f3ab78b70fd33aa017b110f2125097c0b6a017443c6165d148a1"],
    ["Noble", "6a36dd40e8963c850e8737c703d1c3aa0643e0287124296fcbc547f30e512ae4", "aac8992d36f7da55839a485eb53091c21a1a886e7c57893d68d8f46ff048b36f"],
    ["Samurai", "1a36256c64e170d044a148365684719b1cc3a1e9d4be0162eab033ac78fbfd3f", "59af1977831d787253e158a60b77e8d38b5cdfa9ff9421ca0cc5ae29073be9a3"],
    ["SamuraiBlue", "7a380a2418f3c017b9e3572c04a204886a4ffd581c475132c8096dd1125cf15e", "27baba333937192ceea304eaeca1f99422ab8d75a97650455bb7ef388a3c9179"],
  ];

  test("LOOK_BASE_NAMES lists the 16 bases in id order (append-only; never reorder or delete)", () => {
    expect(LOOK_BASE_NAMES).toHaveLength(LOOK_BASES);
    for (let i = 0; i < LOOK_BASES; i++) expect(LOOK_BASE_NAMES[i]).toBe(PINNED[i]![0]);
  });

  test("the generated manifest names match the id-order table (append-only; never reorder or delete)", () => {
    expect(WANDER_LOOK_BASES).toHaveLength(LOOK_BASES);
    for (let i = 0; i < LOOK_BASES; i++) {
      expect(WANDER_LOOK_BASES[i]).toBe(LOOK_BASE_NAMES[i]);
      // Every palette variant of base i carries the base's character name.
      for (let p = 0; p < LOOK_PALETTES; p++) {
        expect(WANDER_LOOKS[i * LOOK_PALETTES + p]!.name).toBe(LOOK_BASE_NAMES[i]);
        expect(WANDER_LOOKS[i * LOOK_PALETTES + p]!.base).toBe(i);
      }
    }
  });

  test("base id -> source sheet content hash is pinned (append-only; never reorder or delete)", async () => {
    for (let i = 0; i < LOOK_BASES; i++) {
      const [name, srcHash] = PINNED[i]!;
      const got = await sha256File(new URL(`${name}.png`, WALK_SRC_DIR));
      expect(got).toBe(srcHash);
    }
  });

  test("base id -> generated palette-0 art hash is pinned, so gen-assets cannot reorder bases (append-only; never reorder or delete)", () => {
    for (let i = 0; i < LOOK_BASES; i++) {
      const [, , genHash] = PINNED[i]!;
      // The pin is over encodePNG(lookFrameRGBA(...)): the exact bytes
      // gen-assets used to write as the committed fixture PNG, so the pins
      // stay valid now that the frames are generated in memory.
      const got = sha256(encodePNG(lookFrameRGBA(i, 0, "idle", "d"), 16, 16));
      expect(got).toBe(genHash);
    }
  });
});

describe("look pool: villager assignment", () => {
  test("deterministic: the same (seed, town, villager) is the same look", () => {
    const a = lookFor(0x5eed_0001, 3, -7, 2);
    const b = lookFor(0x5eed_0001, 3, -7, 2);
    expect(a).toEqual(b);
    // A different seed or villager index (usually) changes the look.
    expect(lookFor(0x5eed_0002, 3, -7, 2)).not.toEqual(a);
  });

  test("the first 16 villagers of a town all wear different bases", () => {
    // The base walks a permutation (step 7, coprime to 16), so a town's
    // villagers 0..15 never share a base character.
    for (const seed of [1, 2, 0x5eed_0001, 0xdead_beef]) {
      for (const [rx, ry] of [[0, 0], [5, -3], [-2, 9]] as const) {
        const bases = new Set<number>();
        for (let n = 0; n < 16; n++) bases.add(lookFor(seed, rx, ry, n).base);
        expect(bases.size).toBe(16);
      }
    }
  });

  test("distribution: 10 seeds x 20 towns, the duplicate rate is low", () => {
    // With 16 distinct bases per town and 4 palettes, two villagers in the
    // same town share a full look only when the base permutation wraps
    // (17+ villagers) and the palette also matches. Measure the actual
    // duplicate rate over 10 seeds x 20 towns x 8 villagers.
    let townSlots = 0;
    let duplicateTowns = 0;
    let totalPairs = 0;
    let duplicatePairs = 0;
    for (let s = 0; s < 10; s++) {
      const seed = (s + 1) * 0x9e37_79b9;
      for (let t = 0; t < 20; t++) {
        const rx = (t * 7) % 13 - 6;
        const ry = (t * 11) % 13 - 6;
        const seen = new Set<number>();
        let dup = false;
        for (let n = 0; n < 8; n++) {
          const id = lookId(lookFor(seed, rx, ry, n));
          if (seen.has(id)) dup = true;
          seen.add(id);
        }
        townSlots++;
        if (dup) duplicateTowns++;
        for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
          totalPairs++;
          if (lookId(lookFor(seed, rx, ry, i)) === lookId(lookFor(seed, rx, ry, j))) duplicatePairs++;
        }
      }
    }
    const pairRate = duplicatePairs / totalPairs;
    // Expect: well under the 1/64 a uniform 64-look draw would give, since
    // the first 16 villagers in a town have distinct bases.
    expect(pairRate).toBeLessThan(0.02);
    console.log(`look distribution: ${duplicateTowns}/${townSlots} towns had a duplicate look; pair duplicate rate ${(pairRate * 100).toFixed(2)}%`);
  });

  test("the same villager in the same town of two worlds can differ", () => {
    // Different seeds may dress the same (rx, ry, n) differently — this is
    // the point of seeding, and it is what a re-roll changes.
    const a = lookId(lookFor(1, 0, 0, 0));
    const b = lookId(lookFor(2, 0, 0, 0));
    expect(a).not.toBe(b);
  });
});

describe("look pool: player look", () => {
  test("playerLook is deterministic per seed", () => {
    expect(playerLook(0x5eed_0001)).toEqual(playerLook(0x5eed_0001));
    expect(playerLook(0x5eed_0001)).not.toEqual(playerLook(0x5eed_0002));
  });

  test("the player look is a valid pool look", () => {
    const look = playerLook(0x5eed_0001);
    expect(look.base).toBeGreaterThanOrEqual(0);
    expect(look.base).toBeLessThan(LOOK_BASES);
    expect(look.palette).toBeGreaterThanOrEqual(0);
    expect(look.palette).toBeLessThan(LOOK_PALETTES);
    expect(WANDER_LOOKS[lookId(look)]).toBeDefined();
  });
});

describe("look pool: villager id parsing", () => {
  test("parseVillagerId round-trips the resident id", () => {
    expect(parseVillagerId("v3_-7_2")).toEqual({ rx: 3, ry: -7, n: 2 });
    expect(parseVillagerId("v0_0_0")).toEqual({ rx: 0, ry: 0, n: 0 });
  });

  test("non-villager ids parse to null", () => {
    expect(parseVillagerId("plaque3_-7")).toBeNull();
    expect(parseVillagerId("player")).toBeNull();
    expect(parseVillagerId("v3_-7")).toBeNull();
  });
});

describe("look pool: build-time palette variants", () => {
  test("every base's three variants differ from the original", () => {
    for (let b = 0; b < LOOK_BASES; b++) {
      const p0 = lookFrameRGBA(b, 0, "idle", "d");
      for (let p = 1; p < LOOK_PALETTES; p++) {
        const pv = lookFrameRGBA(b, p, "idle", "d");
        let diff = 0;
        for (let i = 0; i < p0.length; i++) if (p0[i] !== pv[i]) diff++;
        expect(diff).toBeGreaterThan(0);
      }
    }
  });

  test("palette 0 is the unmodified source art", async () => {
    // Base 0 (Villager) palette 0 idle-down must equal the Walk.png cell at
    // row 0 (idle), col 0 (down).
    const src = decodePng(new Uint8Array(await Bun.file(new URL("../examples/wander/assets/src/ninja-adventure/walk/Villager.png", import.meta.url)).arrayBuffer()));
    const sliced = lookFrameRGBA(0, 0, "idle", "d");
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const si = (y * 64 + x) * 4;
      const di = (y * 16 + x) * 4;
      expect(sliced[di]).toBe(src.rgba[si]);
      expect(sliced[di + 3]).toBe(src.rgba[si + 3]);
    }
  });

  test("the walk frames differ from the idle frame (animation exists)", () => {
    for (let b = 0; b < LOOK_BASES; b++) {
      const idle = lookFrameRGBA(b, 0, "idle", "d");
      const walkL = lookFrameRGBA(b, 0, "walkL", "d");
      const walkR = lookFrameRGBA(b, 0, "walkR", "d");
      const diff = (a: Uint8Array, c: Uint8Array) => {
        let n = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) n++;
        return n;
      };
      expect(diff(idle, walkL)).toBeGreaterThan(0);
      expect(diff(idle, walkR)).toBeGreaterThan(0);
    }
  });

  test("facing frames differ (the character turns)", () => {
    const down = lookFrameRGBA(0, 0, "idle", "d");
    const up = lookFrameRGBA(0, 0, "idle", "u");
    let diff = 0;
    for (let i = 0; i < down.length; i++) if (down[i] !== up[i]) diff++;
    expect(diff).toBeGreaterThan(0);
  });
});

describe("look pool: shipped tilesets decode to the generated frames", () => {
  // The 16 assets/look/tilesets/bNN.pkts are what actually ships; the
  // per-frame pixels exist only as lookFrameRGBA's in-memory output. Decode
  // each TILESET blob the way the runtime fallback does (32-byte header,
  // 8-byte directory entries, PackBits streams, the 1024-byte shared
  // palette) and pin every tile against the pure generator, so a cooking
  // change that desyncs the shipped blobs from the frame function fails.

  /** Decode one tile of a TILESET blob to its 4444-expanded ABGR words. */
  function decodeTile(blob: Uint8Array, index: number): Uint32Array {
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    if (blob.length < TILESET_HEADER_SIZE || dv.getUint32(0, true) !== TILESET_MAGIC || dv.getUint16(4, true) !== TILESET_VERSION) {
      throw new Error("not a TILESET blob");
    }
    const flags = dv.getUint16(6, true);
    const tileW = dv.getUint16(8, true);
    const tileH = dv.getUint16(10, true);
    const cols = dv.getUint16(12, true);
    const paletteOff = dv.getUint32(16, true);
    const dirOff = dv.getUint32(20, true);
    const dataOff = dv.getUint32(24, true);
    if (index < 0 || index >= cols) throw new Error(`tile ${index} out of range`);
    const e = dirOff + index * TILESET_DIR_ENTRY_SIZE;
    const off = dv.getUint32(e, true);
    const len = dv.getUint32(e + 4, true);
    if (off === TILESET_ABSENT || len === 0) throw new Error(`tile ${index} is absent or solid`);
    const px = tileW * tileH;
    const stream = blob.subarray(dataOff + off, dataOff + off + len);
    const indices = (flags & TILESET_FLAG_RLE) !== 0 ? packbitsDecode(stream, px) : stream;
    if (!indices || indices.length !== px) throw new Error(`tile ${index} failed to decode`);
    const words = new Uint32Array(px);
    for (let i = 0; i < px; i++) words[i] = dv.getUint32(paletteOff + indices[i]! * 4, true);
    return words;
  }

  test("all 16 tilesets exist, one per base, each holding 48 tiles", async () => {
    for (let b = 0; b < LOOK_BASES; b++) {
      const bb = String(b).padStart(2, "0");
      const blob = new Uint8Array(await Bun.file(new URL(`b${bb}.pkts`, TILESET_DIR)).arrayBuffer());
      const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      expect(dv.getUint32(0, true)).toBe(TILESET_MAGIC);
      expect(dv.getUint16(12, true)).toBe(LOOK_TILES_PER_BASE);
    }
  });

  test("every tile decodes to exactly the generated frame's quantized words", async () => {
    for (let b = 0; b < LOOK_BASES; b++) {
      const bb = String(b).padStart(2, "0");
      const blob = new Uint8Array(await Bun.file(new URL(`b${bb}.pkts`, TILESET_DIR)).arrayBuffer());
      for (let p = 0; p < LOOK_PALETTE_COUNT; p++) {
        for (const pose of POSES) {
          for (let f = 0; f < 4; f++) {
            const tileIdx = p * 12 + LOOK_POSE_BASE[pose] + f;
            const decoded = decodeTile(blob, tileIdx);
            const expected = quantizedWords(lookFrameRGBA(b, p, pose, FACING_CH[f]!));
            expect(decoded).toEqual(expected);
          }
        }
      }
    }
  });
});
