// examples/wander/helped-bloom.ts — the bounded "has this town been helped"
// memory shared by the single-player sim and the online journey. A 1024-bit
// Bloom filter with three seeded hashes remembers towns that fell out of the
// exact FIFO set; false positives only ever grant extra plaza flowers.
import { growHash } from "./world.ts";

export const HELPED_BLOOM_WORDS = 32;

/** A bounded Bloom filter of helped towns. The exact set (HELP_CAP) drives
 *  dialog and immediate flowers; the Bloom never forgets, so a town helped
 *  long ago still flowers when its plan is regenerated. False positives
 *  only ever add flowers — acceptable. 1024 bits, 3 hashes: a few hundred
 *  helps keep the false-positive rate in the low percent. */
export class HelpedBloom {
  private readonly bits = new Uint32Array(HELPED_BLOOM_WORDS);
  constructor(private readonly seed: number) {}
  add(rx: number, ry: number): void {
    for (const b of this.bitsFor(rx, ry)) this.bits[b >>> 5]! |= 1 << (b & 31);
  }
  has(rx: number, ry: number): boolean {
    for (const b of this.bitsFor(rx, ry)) if (!(this.bits[b >>> 5]! & (1 << (b & 31)))) return false;
    return true;
  }
  private bitsFor(rx: number, ry: number): [number, number, number] {
    const h1 = growHash(this.seed, rx, ry, 0xb100a), h2 = growHash(this.seed, rx, ry, 0xb100b);
    return [h1 % 1024, h2 % 1024, ((h1 ^ (h2 >>> 7)) >>> 0) % 1024];
  }
  toJSON(): number[] { return [...this.bits]; }
  copyFrom(arr: readonly number[]): void {
    this.bits.fill(0);
    for (let i = 0; i < this.bits.length; i++) this.bits[i] = (arr[i] ?? 0) >>> 0;
  }
}
