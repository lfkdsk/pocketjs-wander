import { describe, expect, test } from "bun:test";
import { WanderSim } from "../examples/wander/wander-sim.ts";
import { WORLD_PROTOCOL_VERSION } from "../examples/wander-online/net/protocol.ts";
import { WORLD_STATE_VERSION } from "../examples/wander-online/net/realm-state.ts";
import { GENERATOR_VERSION } from "../examples/wander-online/net/realm-world.ts";
import { AUTH_PROTOCOL_VERSION } from "../examples/wander-online/shared/auth.ts";
import { SOCIAL_PROTOCOL_VERSION } from "../examples/wander-online/shared/social.ts";
import { POSTCARD_PROTOCOL_VERSION } from "../examples/wander-online/shared/postcard.ts";

interface CompatibilityFixture {
  schema: "wander-compat-fixture/v1";
  generatedBy: { wander: string; pocketRpgKit: string };
  singlePlayer: {
    travelLog: string;
    errands: string;
    logDigest: string;
    errandsDigest: string;
  };
}

const fixture = await Bun.file(
  new URL("./fixtures/pre-upgrade-state.json", import.meta.url),
).json() as CompatibilityFixture;

describe("component upgrade compatibility", () => {
  test("a save generated before the component bump restores and keeps stepping", () => {
    expect(fixture.schema).toBe("wander-compat-fixture/v1");
    expect(fixture.generatedBy).toEqual({
      wander: "2d6768ecfe8f6e7453547cfc637a2512b9d40e1a",
      pocketRpgKit: "a4dc4e72341ae6aa7373623f83dbd07124316a6d",
    });

    const sim = new WanderSim({
      seed: 0x3993_6d2c,
      hz: 60,
      viewW: 480,
      viewH: 272,
      manual: true,
    });
    sim.restoreLog(fixture.singlePlayer.travelLog);
    sim.restoreErrands(fixture.singlePlayer.errands);

    expect(sim.logDigest()).toBe(fixture.singlePlayer.logDigest);
    expect(sim.errandsDigest()).toBe(fixture.singlePlayer.errandsDigest);
    expect(sim.serializeLog()).toBe(fixture.singlePlayer.travelLog);
    expect(sim.serializeErrands()).toBe(fixture.singlePlayer.errands);

    const before = sim.digest();
    sim.step(0);
    expect(sim.digest()).not.toBe(before);
    expect(sim.logDigest()).toBe(fixture.singlePlayer.logDigest);
    expect(sim.errandsDigest()).toBe(fixture.singlePlayer.errandsDigest);
  });

  test("the additive component bump does not move any online protocol", () => {
    expect({
      world: WORLD_PROTOCOL_VERSION,
      worldState: WORLD_STATE_VERSION,
      generator: GENERATOR_VERSION,
      auth: AUTH_PROTOCOL_VERSION,
      social: SOCIAL_PROTOCOL_VERSION,
      postcard: POSTCARD_PROTOCOL_VERSION,
    }).toEqual({ world: 4, worldState: 1, generator: 1, auth: 3, social: 1, postcard: 1 });
  });
});
