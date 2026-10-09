import { describe, expect, test } from "bun:test";
import { browserErrorFromEvent, inviteLinkHasToken, pageUrl, parseFlags } from "../examples/wander-online/web-check.ts";

describe("wander-online web-check flags", () => {
  test("defaults the all-room expectation to the current-room expectation", () => {
    const flags = parseFlags(["--expect", "3"]);
    expect(flags.expect).toBe(3);
    expect(flags.expectAll).toBe(3);
    expect(flags.ticket).toBeNull();
    expect(flags.wideOut).toBeNull();
    expect(flags.expectRealm).toBeNull();
    expect(flags.expectFirst).toBe(false);
    expect(flags.expectProgress).toBe(0);
    expect(flags.expectImprovement).toBe(0);
    expect(flags.autoWalk).toBe(false);
    expect(flags.mintInvite).toBe(false);
    expect(flags.meetPrefix).toBeNull();
    expect(flags.expectReject).toBeNull();
    expect(flags.closePage).toBe(false);
  });

  test("accepts an independent cross-room total and an auth ticket", () => {
    const flags = parseFlags([
      "--expect", "2",
      "--expect-all", "17",
      "--ticket", "secret-ticket",
      "--wide-out", "wide.png",
      "--expect-realm", "plaza-1",
      "--expect-first",
      "--expect-progress", "1",
      "--expect-improvement", "2",
      "--auto-walk",
      "--mint-invite",
      "--meet-prefix", "evidence/web",
      "--expect-reject", "WORLD FULL",
      "--close-page",
      "--watch",
    ]);
    expect(flags.expect).toBe(2);
    expect(flags.expectAll).toBe(17);
    expect(flags.ticket).toBe("secret-ticket");
    expect(flags.wideOut).toBe("wide.png");
    expect(flags.expectRealm).toBe("plaza-1");
    expect(flags.expectFirst).toBe(true);
    expect(flags.expectProgress).toBe(1);
    expect(flags.expectImprovement).toBe(2);
    expect(flags.autoWalk).toBe(true);
    expect(flags.mintInvite).toBe(true);
    expect(flags.meetPrefix).toBe("evidence/web");
    expect(flags.expectReject).toBe("WORLD FULL");
    expect(flags.closePage).toBe(true);
    expect(flags.watch).toBe(true);
  });
});

describe("wander-online web-check browser diagnostics", () => {
  test("captures console.error arguments but ignores warnings", () => {
    expect(browserErrorFromEvent("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ type: "string", value: "boot failed" }, { type: "number", value: 17 }],
    })).toBe("console.error: boot failed 17");
    expect(browserErrorFromEvent("Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ type: "string", value: "expected warning" }],
    })).toBeNull();
  });

  test("captures uncaught exceptions with their source line", () => {
    expect(browserErrorFromEvent("Runtime.exceptionThrown", {
      exceptionDetails: {
        text: "Uncaught",
        exception: { type: "object", description: "Error: bad frame" },
        url: "http://127.0.0.1/player.js",
        lineNumber: 41,
      },
    })).toBe("uncaught exception: Error: bad frame at http://127.0.0.1/player.js:42");
  });
});

describe("wander-online web-check invite navigation", () => {
  test("enters through the real fragment and preserves other fragment options", () => {
    expect(pageUrl("http://127.0.0.1:9003/wander-online/", "plaza-2.5QX9HHFY"))
      .toBe("http://127.0.0.1:9003/wander-online/#invite=plaza-2.5QX9HHFY");
    expect(pageUrl("http://127.0.0.1:9003/wander-online/#debug=1", "plaza-2.A+B"))
      .toBe("http://127.0.0.1:9003/wander-online/#debug=1&invite=plaza-2.A%2BB");
    expect(pageUrl("http://127.0.0.1:9003/wander-online/", null))
      .toBe("http://127.0.0.1:9003/wander-online/");
  });

  test("matches the minted token in the page's shareable link", () => {
    expect(inviteLinkHasToken("http://127.0.0.1:9003/wander-online/#invite=plaza-2.ABC123", "plaza-2.ABC123")).toBe(true);
    expect(inviteLinkHasToken("http://127.0.0.1:9003/wander-online/#invite=plaza-1.WRONG", "plaza-2.ABC123")).toBe(false);
  });
});
