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
    expect(parsePostcardMailbox({ unread: 1, total: 1, dailyRemaining: 3, postcards: [first] })).toEqual({
      unread: 1,
      total: 1,
      dailyRemaining: 3,
      postcards: [first],
    });
    expect(parsePostcardMailbox({ unread: 0, total: 1, dailyRemaining: 3, postcards: [first] })).toBeNull();
    expect(parsePostcardMailbox({ unread: 2, total: 2, dailyRemaining: 3, postcards: [first, first] })).toBeNull();
    expect(parsePostcardMailbox({
      unread: 1,
      total: 1,
      dailyRemaining: 3,
      postcards: [{ ...first, senderRealm: "secret", senderX: 12, senderY: 9 }],
    })?.postcards[0]).toEqual(first);
  });

  test("status counters stay inside server authority limits", () => {
    expect(parsePostcardStatus({ unread: 1, total: 2, dailyRemaining: 4 })).toEqual({ unread: 1, total: 2, dailyRemaining: 4 });
    expect(parsePostcardStatus({ unread: 3, total: 2, dailyRemaining: 4 })).toBeNull();
    expect(parsePostcardStatus({ unread: 0, total: POSTCARD_MAILBOX_CAP + 1, dailyRemaining: 4 })).toBeNull();
    expect(parsePostcardStatus({ unread: 0, total: 0, dailyRemaining: POSTCARD_DAILY_SEND_LIMIT + 1 })).toBeNull();
  });
});
