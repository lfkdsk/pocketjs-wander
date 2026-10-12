// examples/wander-online/postcard-model.ts — pure controller flow for a
// town notice board's postal counter. Network and physical proximity remain
// the parent's responsibility; this module only presents bounded server data
// and returns typed actions.

import {
  POSTCARD_SENTENCE_IDS,
  formatPostcardSentence,
  type PostcardDraft,
  type PostcardLocale,
  type PostcardMailbox,
  type PostcardMessage,
  type PostcardSentenceId,
  type PostcardStatus,
} from "./shared/postcard.ts";
import type { FriendView } from "./shared/social.ts";
import {
  SOCIAL_PAGE_ROWS,
  fitSocialText,
  socialPanelLayout,
  socialPanelRowRect,
  type SocialPanelLayout,
  type SocialRect,
  type SocialRowTone,
} from "./social-model.ts";

export { socialPanelLayout as postcardPanelLayout, socialPanelRowRect as postcardPanelRowRect };
export type { SocialPanelLayout as PostcardPanelLayout, SocialRect as PostcardRect };

/** Wide postcard rows use both social-panel columns. Derive their conservative
 * display-cell budget from the actual responsive body width, including the
 * 360 px phone-landscape lane, instead of assuming the 480 px baseline. */
export function postcardPanelWideCells(layout: SocialPanelLayout): number {
  const textWidth = Math.max(0, layout.body.w - 12 * layout.scale);
  return Math.max(1, Math.floor(textWidth / (8 * layout.scale)));
}

export function fitPostcardWideText(value: string, layout: SocialPanelLayout): string {
  return fitSocialText(value, postcardPanelWideCells(layout));
}

export type PostcardScreen = "home" | "inbox" | "read" | "recipients" | "phrases" | "postmarks" | "review";
export type PostcardInput = "up" | "down" | "confirm" | "back";

export interface PostmarkOption {
  rx: number;
  ry: number;
  /** Sender-only selection copy. The server derives recipient copy itself. */
  label: string;
}

export interface PostcardMenuData {
  status: PostcardStatus | null;
  mailbox: PostcardMailbox | null;
  friends: readonly FriendView[];
  postmarks: readonly PostmarkOption[];
  locale: PostcardLocale;
}

export interface PostcardMenuState {
  screen: PostcardScreen;
  cursor: number;
  page: number;
  recipient: { githubId: number; name: string } | null;
  sentenceId: PostcardSentenceId;
  postmark: PostmarkOption | null;
  readingId: string | null;
}

export type PostcardAction =
  | { type: "close" }
  | { type: "read"; id: string }
  | { type: "send"; draft: PostcardDraft };

export interface PostcardTransition {
  state: PostcardMenuState;
  action: PostcardAction | null;
}

export interface PostcardMenuRow {
  key: string;
  label: string;
  detail: string;
  tone: SocialRowTone;
  /** A body/phrase row takes both presentation columns. */
  wide?: boolean;
  postcard?: PostcardMessage;
  friend?: FriendView;
  sentenceId?: PostcardSentenceId;
  postmark?: PostmarkOption | null;
}

export interface PostcardMenuView {
  state: PostcardMenuState;
  title: string;
  rows: PostcardMenuRow[];
  page: number;
  pages: number;
  footer: string;
}

const COPY = {
  en: {
    postOffice: "POST OFFICE",
    mailbox: "MAILBOX",
    send: "SEND A POSTCARD",
    leave: "LEAVE",
    unread: "UNREAD",
    today: "LEFT TODAY",
    empty: "NO POSTCARDS",
    noFriends: "NO FRIENDS AVAILABLE",
    recipients: "CHOOSE A FRIEND",
    phrases: "CHOOSE A MESSAGE",
    postmarks: "CHOOSE A POSTMARK",
    noPostmark: "NO POSTMARK",
    review: "REVIEW POSTCARD",
    to: "TO",
    message: "MESSAGE",
    postmark: "POSTMARK",
    sendNow: "SEND NOW",
    read: "READ",
    new: "NEW",
    from: "FROM",
    open: "OPEN",
    select: "SELECT",
    close: "CLOSE",
    back: "BACK",
    online: "ONLINE",
    offline: "OFFLINE",
    hidden: "HIDDEN",
  },
  zh: {
    postOffice: "邮局",
    mailbox: "信箱",
    send: "寄一张明信片",
    leave: "离开邮局",
    unread: "封未读",
    today: "今日可寄",
    empty: "信箱里还没有明信片",
    noFriends: "暂无可寄信的好友",
    recipients: "选择好友",
    phrases: "选择问候语",
    postmarks: "选择邮戳",
    noPostmark: "不附邮戳",
    review: "确认明信片",
    to: "收件人",
    message: "正文",
    postmark: "邮戳",
    sendNow: "确认寄出",
    read: "已读",
    new: "未读",
    from: "寄件人",
    open: "打开",
    select: "选择",
    close: "关闭",
    back: "返回",
    online: "在线",
    offline: "离线",
    hidden: "隐藏",
  },
} as const;

function copy(data: PostcardMenuData) {
  return COPY[data.locale];
}

function row(
  key: string,
  label: string,
  detail = "",
  tone: SocialRowTone = "normal",
  extra: Partial<PostcardMenuRow> = {},
): PostcardMenuRow {
  return { key, label: fitSocialText(label, 54), detail: fitSocialText(detail, 14), tone, ...extra };
}

function reading(state: PostcardMenuState, data: PostcardMenuData): PostcardMessage | null {
  return data.mailbox?.postcards.find((postcard) => postcard.id === state.readingId) ?? null;
}

export function postcardMenuRows(state: PostcardMenuState, data: PostcardMenuData): PostcardMenuRow[] {
  const words = copy(data);
  switch (state.screen) {
    case "home":
      return [
        row("route-inbox", words.mailbox, `${data.status?.unread ?? 0} ${words.unread}`, "accent"),
        row("route-send", words.send, `${words.today} ${data.status?.dailyRemaining ?? 0}`, "accent"),
        row("route-close", words.leave, "", "muted"),
      ];
    case "inbox": {
      const cards = data.mailbox?.postcards ?? [];
      return cards.length > 0
        ? cards.map((postcard) => row(
          `postcard-${postcard.id}`,
          postcard.senderName,
          postcard.read ? words.read : words.new,
          postcard.read ? "normal" : "accent",
          { postcard },
        ))
        : [row("inbox-empty", words.empty, "", "muted", { wide: true })];
    }
    case "read": {
      const postcard = reading(state, data);
      if (!postcard) return [row("read-missing", words.empty, "", "muted", { wide: true })];
      return [
        row("read-from", words.from, postcard.senderName, "accent"),
        row("read-message", formatPostcardSentence(postcard.sentenceId, data.locale), "", "normal", { wide: true }),
        row("read-postmark", postcard.postmark ? `${words.postmark}: ${postcard.postmark}` : words.noPostmark, "", "muted", { wide: true }),
      ];
    }
    case "recipients": {
      return data.friends.length > 0
        ? data.friends.map((friend) => row(
          `recipient-${friend.githubId}`,
          friend.name,
          words[friend.presence],
          friend.presence === "online" ? "accent" : "normal",
          { friend },
        ))
        : [row("recipients-empty", words.noFriends, "", "muted", { wide: true })];
    }
    case "phrases":
      return POSTCARD_SENTENCE_IDS.map((sentenceId) => row(
        `phrase-${sentenceId}`,
        formatPostcardSentence(sentenceId, data.locale),
        "",
        sentenceId === state.sentenceId ? "accent" : "normal",
        { wide: true, sentenceId },
      ));
    case "postmarks":
      return [
        row("postmark-none", words.noPostmark, "", state.postmark === null ? "accent" : "normal", { wide: true, postmark: null }),
        ...data.postmarks.map((postmark) => row(
          `postmark-${postmark.rx},${postmark.ry}`,
          postmark.label,
          "",
          state.postmark?.rx === postmark.rx && state.postmark.ry === postmark.ry ? "accent" : "normal",
          { wide: true, postmark },
        )),
      ];
    case "review":
      return [
        row("review-to", words.to, state.recipient?.name ?? "—", "accent"),
        row("review-message", `${words.message}: ${formatPostcardSentence(state.sentenceId, data.locale)}`, "", "normal", { wide: true }),
        row("review-postmark", `${words.postmark}: ${state.postmark?.label ?? words.noPostmark}`, "", "muted", { wide: true }),
        row("review-send", words.sendNow, "", "accent", { wide: true }),
      ];
  }
}

export function createPostcardMenuState(): PostcardMenuState {
  return {
    screen: "home",
    cursor: 0,
    page: 0,
    recipient: null,
    sentenceId: POSTCARD_SENTENCE_IDS[0],
    postmark: null,
    readingId: null,
  };
}

export function normalizePostcardMenuState(state: PostcardMenuState, data: PostcardMenuData): PostcardMenuState {
  const rows = postcardMenuRows(state, data);
  const cursor = Math.max(0, Math.min(Math.max(0, rows.length - 1), Math.floor(state.cursor)));
  return { ...state, cursor, page: Math.floor(cursor / SOCIAL_PAGE_ROWS) };
}

function enter(state: PostcardMenuState, screen: PostcardScreen, cursor = 0): PostcardMenuState {
  return { ...state, screen, cursor, page: Math.floor(cursor / SOCIAL_PAGE_ROWS) };
}

export function reducePostcardMenu(
  state: PostcardMenuState,
  input: PostcardInput,
  data: PostcardMenuData,
): PostcardTransition {
  const current = normalizePostcardMenuState(state, data);
  const rows = postcardMenuRows(current, data);
  if (input === "up" || input === "down") {
    const cursor = Math.max(0, Math.min(rows.length - 1, current.cursor + (input === "up" ? -1 : 1)));
    return { state: { ...current, cursor, page: Math.floor(cursor / SOCIAL_PAGE_ROWS) }, action: null };
  }
  if (input === "back") {
    const previous: Partial<Record<PostcardScreen, PostcardScreen>> = {
      inbox: "home",
      read: "inbox",
      recipients: "home",
      phrases: "recipients",
      postmarks: "phrases",
      review: "postmarks",
    };
    return current.screen === "home"
      ? { state: current, action: { type: "close" } }
      : { state: enter(current, previous[current.screen] ?? "home"), action: null };
  }
  if (input !== "confirm") return { state: current, action: null };
  const selected = rows[current.cursor];
  if (current.screen === "home") {
    if (selected?.key === "route-inbox") return { state: enter(current, "inbox"), action: null };
    if (selected?.key === "route-send") return { state: enter(current, "recipients"), action: null };
    if (selected?.key === "route-close") return { state: current, action: { type: "close" } };
  }
  if (current.screen === "inbox" && selected?.postcard) {
    const postcard = selected.postcard;
    return {
      state: enter({ ...current, readingId: postcard.id }, "read"),
      action: postcard.read ? null : { type: "read", id: postcard.id },
    };
  }
  if (current.screen === "recipients" && selected?.friend) {
    return {
      state: enter({ ...current, recipient: { githubId: selected.friend.githubId, name: selected.friend.name } }, "phrases"),
      action: null,
    };
  }
  if (current.screen === "phrases" && selected?.sentenceId) {
    return { state: enter({ ...current, sentenceId: selected.sentenceId }, "postmarks"), action: null };
  }
  if (current.screen === "postmarks" && selected && Object.hasOwn(selected, "postmark")) {
    return { state: enter({ ...current, postmark: selected.postmark ?? null }, "review", 3), action: null };
  }
  if (current.screen === "review" && selected?.key === "review-send" && current.recipient) {
    return {
      state: current,
      action: {
        type: "send",
        draft: {
          targetGithubId: current.recipient.githubId,
          sentenceId: current.sentenceId,
          postmark: current.postmark ? { rx: current.postmark.rx, ry: current.postmark.ry } : null,
        },
      },
    };
  }
  return { state: current, action: null };
}

export function postcardMenuView(state: PostcardMenuState, data: PostcardMenuData): PostcardMenuView {
  const normalized = normalizePostcardMenuState(state, data);
  const rows = postcardMenuRows(normalized, data);
  const pages = Math.max(1, Math.ceil(rows.length / SOCIAL_PAGE_ROWS));
  const start = normalized.page * SOCIAL_PAGE_ROWS;
  const words = copy(data);
  const titles: Record<PostcardScreen, string> = {
    home: words.postOffice,
    inbox: words.mailbox,
    read: words.mailbox,
    recipients: words.recipients,
    phrases: words.phrases,
    postmarks: words.postmarks,
    review: words.review,
  };
  return {
    state: normalized,
    title: titles[normalized.screen],
    rows: rows.slice(start, start + SOCIAL_PAGE_ROWS),
    page: normalized.page,
    pages,
    footer: normalized.screen === "home"
      ? `CIRCLE ${words.open} · CROSS ${words.close}`
      : `CIRCLE ${words.select} · CROSS ${words.back}`,
  };
}

/** Return to a fresh home after the server confirms a send. */
export function postcardSendComplete(): PostcardMenuState {
  return createPostcardMenuState();
}
