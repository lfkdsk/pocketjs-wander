import { describe, expect, test } from "bun:test";
import {
  POSTCARD_DAILY_SEND_LIMIT,
  POSTCARD_MAILBOX_CAP,
  POSTCARD_SENTENCE_IDS,
  formatPostcardSentence,
  parsePostcardDraft,
  parsePostcardMailbox,
  parsePostcardStatus,
} from "../examples/wander-online/shared/postcard.ts";
import {
  createPostcardMenuState,
  fitPostcardWideText,
  postcardMenuRows,
  postcardMenuView,
  postcardPanelLayout,
  postcardPanelWideCells,
  reducePostcardMenu,
  type PostcardMenuData,
} from "../examples/wander-online/postcard-model.ts";
import { measureSocialCells } from "../examples/wander-online/social-model.ts";

describe("postcard shared contract", () => {
  test("only preset sentence ids and int32 discovery coordinates form a draft", () => {
    expect(parsePostcardDraft({
      targetGithubId: 42,
      sentenceId: "thanks",
      postmark: { rx: -17, ry: 23 },
      body: "forged free text",
    })).toEqual({ targetGithubId: 42, sentenceId: "thanks", postmark: { rx: -17, ry: 23 } });
    expect(parsePostcardDraft({ targetGithubId: 42, sentenceId: "hello", postmark: null })).toEqual({
      targetGithubId: 42,
      sentenceId: "hello",
      postmark: null,
    });
    expect(parsePostcardDraft({ targetGithubId: 42, sentenceId: "custom", postmark: null })).toBeNull();
    expect(parsePostcardDraft({ targetGithubId: 42, sentenceId: "hello", postmark: { rx: 2 ** 31, ry: 0 } })).toBeNull();
    expect(parsePostcardDraft({ targetGithubId: 0, sentenceId: "hello", postmark: null })).toBeNull();
  });

  test("the bilingual phrase book is complete and never accepts free text", () => {
    expect(POSTCARD_SENTENCE_IDS).toHaveLength(6);
    for (const id of POSTCARD_SENTENCE_IDS) {
      expect(formatPostcardSentence(id, "en").length).toBeGreaterThan(10);
      expect(formatPostcardSentence(id, "zh").length).toBeGreaterThan(6);
      expect(formatPostcardSentence(id, "en")).not.toBe(formatPostcardSentence(id, "zh"));
      expect(formatPostcardSentence(id, "zh")).not.toMatch(/[，！。]/);
    }
  });

  test("mailbox parsing pins count, unread state, ids and privacy-safe fields", () => {
    const first = {
      id: "pc_abcdefgh1234",
      senderName: "Alice",
      sentenceId: "recommend",
      postmark: "Ancient Tree",
      sentAt: 1_000,
      expiresAt: 2_000,
      read: false,
    } as const;
    expect(parsePostcardMailbox({ revision: 4, unread: 1, total: 1, dailyRemaining: 3, postcards: [first] })).toEqual({
      revision: 4,
      unread: 1,
      total: 1,
      dailyRemaining: 3,
      postcards: [first],
    });
    expect(parsePostcardMailbox({ revision: 4, unread: 0, total: 1, dailyRemaining: 3, postcards: [first] })).toBeNull();
    expect(parsePostcardMailbox({ revision: 4, unread: 2, total: 2, dailyRemaining: 3, postcards: [first, first] })).toBeNull();
    expect(parsePostcardMailbox({
      revision: 4,
      unread: 1,
      total: 1,
      dailyRemaining: 3,
      postcards: [{ ...first, senderRealm: "secret", senderX: 12, senderY: 9 }],
    })?.postcards[0]).toEqual(first);
  });

  test("status counters stay inside server authority limits", () => {
    expect(parsePostcardStatus({ revision: 3, unread: 1, total: 2, dailyRemaining: 4 })).toEqual({ revision: 3, unread: 1, total: 2, dailyRemaining: 4 });
    expect(parsePostcardStatus({ revision: -1, unread: 1, total: 2, dailyRemaining: 4 })).toBeNull();
    expect(parsePostcardStatus({ revision: 3, unread: 3, total: 2, dailyRemaining: 4 })).toBeNull();
    expect(parsePostcardStatus({ revision: 3, unread: 0, total: POSTCARD_MAILBOX_CAP + 1, dailyRemaining: 4 })).toBeNull();
    expect(parsePostcardStatus({ revision: 3, unread: 0, total: 0, dailyRemaining: POSTCARD_DAILY_SEND_LIMIT + 1 })).toBeNull();
  });
});

describe("postcard controller flow", () => {
  const mailbox = {
    revision: 3,
    unread: 1,
    total: 1,
    dailyRemaining: 4,
    postcards: [{
      id: "pc_abcdefgh1234",
      senderName: "Alice",
      sentenceId: "thanks" as const,
      postmark: "Ancient Tree",
      sentAt: 1_000,
      expiresAt: 2_000,
      read: false,
    }],
  };
  const data: PostcardMenuData = {
    status: mailbox,
    mailbox,
    friends: [{ githubId: 7, name: "Bob", presence: "offline", realm: null }],
    postmarks: [{ rx: -2, ry: 5, label: "Ancient Tree · Mossvale" }],
    locale: "en",
  };

  test("reading one unread card emits exactly one server action", () => {
    let state = createPostcardMenuState();
    state = reducePostcardMenu(state, "confirm", data).state;
    expect(state.screen).toBe("inbox");
    const opened = reducePostcardMenu(state, "confirm", data);
    expect(opened.state.screen).toBe("read");
    expect(opened.action).toEqual({ type: "read", id: "pc_abcdefgh1234" });
    expect(postcardMenuRows(opened.state, data).map((entry) => entry.label)).toContain(
      formatPostcardSentence("thanks", "en"),
    );
    expect(reducePostcardMenu(opened.state, "back", data).state.screen).toBe("inbox");
  });

  test("compose chooses a mutual friend, preset and discovered stamp before send", () => {
    let state = createPostcardMenuState();
    state = reducePostcardMenu(state, "down", data).state;
    state = reducePostcardMenu(state, "confirm", data).state;
    expect(state.screen).toBe("recipients");
    state = reducePostcardMenu(state, "confirm", data).state;
    expect(state.screen).toBe("phrases");
    state = reducePostcardMenu(state, "down", data).state;
    state = reducePostcardMenu(state, "down", data).state;
    state = reducePostcardMenu(state, "confirm", data).state;
    expect(state.sentenceId).toBe("thanks");
    expect(state.screen).toBe("postmarks");
    state = reducePostcardMenu(state, "down", data).state;
    state = reducePostcardMenu(state, "confirm", data).state;
    expect(state.screen).toBe("review");
    expect(state.cursor).toBe(3);
    expect(reducePostcardMenu(state, "confirm", data).action).toEqual({
      type: "send",
      draft: {
        targetGithubId: 7,
        sentenceId: "thanks",
        postmark: { rx: -2, ry: 5 },
      },
    });
  });

  test("Chinese rows use translated phrase and post-office copy", () => {
    const zh: PostcardMenuData = { ...data, locale: "zh" };
    expect(postcardMenuRows(createPostcardMenuState(), zh).map((entry) => entry.label)).toEqual([
      "信箱",
      "寄一张明信片",
      "离开邮局",
    ]);
    expect(postcardMenuRows({ ...createPostcardMenuState(), screen: "recipients" }, zh)[0]?.detail).toBe("离线");
    const phrases = postcardMenuRows({ ...createPostcardMenuState(), screen: "phrases" }, zh);
    expect(phrases.map((entry) => entry.label)).toContain(formatPostcardSentence("recommend", "zh"));
    expect(postcardMenuView(createPostcardMenuState(), zh).footer).toBe("CIRCLE 打开 · CROSS 关闭");
    expect(postcardMenuView({ ...createPostcardMenuState(), screen: "phrases" }, zh).footer).toBe("CIRCLE 选择 · CROSS 返回");
  });

  test("wide postcard rows ellipsize to each responsive panel's real text width", () => {
    const state = {
      ...createPostcardMenuState(),
      screen: "review" as const,
      recipient: { githubId: 7, name: "Bob" },
      sentenceId: "thanks" as const,
    };
    const message = postcardMenuRows(state, data).find((entry) => entry.key === "review-message")!.label;
    const portrait = postcardPanelLayout(390, 844);
    const landscape = postcardPanelLayout(844, 390);
    const baseline = postcardPanelLayout(480, 272);

    expect(postcardPanelWideCells(portrait)).toBe(42);
    expect(postcardPanelWideCells(landscape)).toBe(40);
    expect(postcardPanelWideCells(baseline)).toBe(53);
    for (const layout of [portrait, landscape]) {
      const fitted = fitPostcardWideText(message, layout);
      expect(fitted.endsWith("…")).toBe(true);
      expect(measureSocialCells(fitted)).toBeLessThanOrEqual(postcardPanelWideCells(layout));
    }
    expect(fitPostcardWideText(message, baseline)).toBe(message);
  });
});
