// Push notifications for the Pocket iOS app: the parts that don't touch bb.
//
// server.ts decides which threads to look at and fetches what they said; this
// file holds the rules (when a message is worth a notification, which reply
// choices ride along), the APNs payload the app is coded against, and the
// ES256 token APNs wants. Kept free of bb so it can be tested on its own.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

export type Kind = "reply" | "approval" | "question";
export type Choice = { label: string; text: string };

// One thing worth telling you about: an agent message, or a pending interaction.
export type Notice = {
  threadId: string;
  kind: Kind;
  title: string;
  body: string;
  forAt: number;
  interactionId?: string;
  // A question's id: `answer` keys the picked choice by it.
  questionId?: string;
  // Whether the question takes a typed answer (bb's allowFreeText). The app
  // only answers Reply… as freeText when true; otherwise it sends a message.
  allowFreeText?: boolean;
  choices?: Choice[];
  recommended?: number;
};

export const CATEGORY: Record<Kind, string> = {
  reply: "POCKET_REPLY",
  approval: "POCKET_APPROVAL",
  question: "POCKET_QUESTION",
};

export const BODY_MAX = 140;
export const TITLE_MAX = 60;
export const CHOICES_MAX = 3;

// Same rule as the quick-reply pills: nothing that tells an agent to send,
// post or delete anything. Lives here so the notifier and the pills share it.
export const UNSAFE_PILL = /\b(send|sends|sent|post|posts|publish|forward|e-?mail (it|him|her|them)|reply all|delete|remove|archive|trash)\b/i;
export const safePill = (p: Choice) =>
  !UNSAFE_PILL.test(`${p.label} ${p.text}`) && !/^(something else|other|none of these)\.?$/i.test(p.text.trim());

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Markdown to one plain line: headings, emphasis, code, links and bullets dropped. */
export function plainText(md: string, max = BODY_MAX): string {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split("\n")
    .map((l) => l.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "").replace(/\|/g, " "))
    .join(" ")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clip(text, max);
}

/** What a permission request wants, in a line (the summary) plus its detail. */
export function describeApproval(p: Record<string, any>): { summary: string; detail: string | null } {
  const s = p.subject ?? {};
  let summary = "Approve this step?";
  let detail: string | null = p.reason ?? null;
  if (s.kind === "command") {
    summary = "Run a command";
    detail = s.command;
  } else if (s.kind === "file_change") {
    summary = "Change files";
    detail = s.writeScope ?? detail;
  } else if (s.kind === "permission_grant") {
    summary = `Grant permissions${s.toolName ? ` to ${s.toolName}` : ""}`;
  } else if (s.kind === "plan") {
    summary = "Approve the plan";
    detail = s.plan;
  } else if (s.kind === "tool_use") {
    summary = s.presentation?.title ?? s.presentation?.label?.pending ?? `Use ${s.tool}`;
    detail = s.presentation?.detail ?? detail;
  }
  return { summary, detail: typeof detail === "string" ? detail : null };
}

/**
 * The notice for a pending interaction, or null for a shape a notification
 * can't carry. A question gets tappable choices only when it is a single
 * single-select question; otherwise it opens the app.
 */
export function interactionNotice(threadId: string, title: string, i: { id: string; createdAt: number; payload: Record<string, any> }): Notice | null {
  const p = i.payload;
  if (p.kind === "approval") {
    const { summary, detail } = describeApproval(p);
    const body = detail ? `${summary}: ${detail}` : summary;
    return { threadId, kind: "approval", title, body: plainText(body), forAt: i.createdAt, interactionId: i.id };
  }
  if (p.kind === "user_question" && Array.isArray(p.questions) && p.questions.length) {
    const qs = p.questions as Array<{ id: string; prompt?: string; multiSelect?: boolean; allowFreeText?: boolean; options?: Array<{ label: string; value: string }> }>;
    const q = qs[0];
    const extra = qs.length > 1 ? ` (+${qs.length - 1} more)` : "";
    const n: Notice = { threadId, kind: "question", title, body: plainText(`${q.prompt ?? "A question for you"}${extra}`), forAt: i.createdAt, interactionId: i.id,
      ...(qs.length === 1 ? { questionId: String(q.id), allowFreeText: q.allowFreeText === true } : { allowFreeText: false }) };
    if (qs.length === 1 && !q.multiSelect && q.options?.length) {
      // text = the option's value: what `answer` takes in `selected`.
      const choices = q.options.map((o) => ({ label: String(o.label), text: String(o.value) })).filter((c) => c.label && c.text && safePill(c));
      if (choices.length) Object.assign(n, { choices: choices.slice(0, CHOICES_MAX) });
    }
    return n;
  }
  return null;
}

/**
 * Reply choices for an agent message: a stale-thread recommendation for this
 * very message wins (its pick first, marked recommended), else the cached
 * quick-reply pills. Every choice passes the unsafe-pill filter.
 */
export function replyChoices(
  forAt: number,
  rec: { forAt: number; pills: Choice[]; recommended: number } | null,
  pills: { forAt: number; pills: Choice[] } | null,
): { choices: Choice[]; recommended?: number } {
  if (rec && rec.forAt === forAt && rec.pills.length) {
    const pick = rec.recommended >= 0 ? rec.pills[rec.recommended] : undefined;
    const rest = rec.pills.filter((p) => p !== pick);
    const ordered = (pick ? [pick, ...rest] : rest).filter(safePill);
    const recommended = pick && ordered[0] === pick ? 0 : undefined;
    return { choices: ordered.slice(0, CHOICES_MAX), ...(recommended === 0 ? { recommended } : {}) };
  }
  if (pills && pills.forAt === forAt) return { choices: pills.pills.filter(safePill).slice(0, CHOICES_MAX) };
  return { choices: [] };
}

// ---- when to notify --------------------------------------------------------

// Per thread: the newest agent message already handled (notified, or passed
// over as older than the cutoff), the interactions handled, and the
// thread's attention/update stamps last looked at, so an unchanged thread
// costs nothing on the next poll.
export type NotifState = { forAt: number; ints: string[]; attn: number; upd: number };
export const emptyState = (): NotifState => ({ forAt: 0, ints: [], attn: -1, upd: -1 });

export type Verdict = "notify" | "old" | "read" | "done";

/**
 * Should this agent message (or interaction, by its createdAt) be notified?
 * `done`: already handled. `old`: from before the no-backlog cutoff. `read`:
 * you read the thread after it arrived (checked only when `needsUnread`).
 */
export function verdict(opts: { forAt: number; handledForAt: number; cutoff: number; lastReadAt: number | null | undefined; needsUnread: boolean }): Verdict {
  if (opts.forAt <= opts.handledForAt) return "done";
  if (opts.forAt < opts.cutoff) return "old";
  if (opts.needsUnread && (opts.lastReadAt ?? 0) >= opts.forAt) return "read";
  return "notify";
}

/** At most `max` sends in any `windowMs`; `take` spends one if there is room. */
export class RateLimit {
  private sent: number[] = [];
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) { this.max = max; this.windowMs = windowMs; }
  room(now: number): number {
    this.sent = this.sent.filter((t) => now - t < this.windowMs);
    return this.max - this.sent.length;
  }
  take(now: number): boolean {
    if (this.room(now) <= 0) return false;
    this.sent.push(now);
    return true;
  }
}

// ---- the APNs payload (the app codes against this; see NOTIFICATIONS.md) ---

// ---- your notification settings (Pocket's Notifications screen) -----------

export type NotifyPrefs = {
  kinds: Record<Kind, boolean>;
  // Quiet hours, in your time zone: notifications still arrive, silently (no
  // sound, screen stays dark) and everything still waits in Needs you.
  quiet: { on: boolean; start: string; end: string; tz: string };
};
export const DEFAULT_PREFS: NotifyPrefs = {
  kinds: { approval: true, question: true, reply: true },
  quiet: { on: false, start: "22:00", end: "07:00", tz: "UTC" },
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export function normalizePrefs(x: unknown): NotifyPrefs {
  const p = (x ?? {}) as Partial<NotifyPrefs>;
  const k = (p.kinds ?? {}) as Partial<Record<Kind, boolean>>;
  const q = (p.quiet ?? {}) as Partial<NotifyPrefs["quiet"]>;
  let tz = typeof q.tz === "string" && q.tz ? q.tz : DEFAULT_PREFS.quiet.tz;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = DEFAULT_PREFS.quiet.tz; }
  return {
    kinds: { approval: k.approval !== false, question: k.question !== false, reply: k.reply !== false },
    quiet: {
      on: q.on === true,
      start: typeof q.start === "string" && HHMM.test(q.start) ? q.start : DEFAULT_PREFS.quiet.start,
      end: typeof q.end === "string" && HHMM.test(q.end) ? q.end : DEFAULT_PREFS.quiet.end,
      tz,
    },
  };
}
/** Minutes since midnight in `tz`. */
function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((x) => x.type === "hour")?.value ?? 0), m = Number(parts.find((x) => x.type === "minute")?.value ?? 0);
  return h * 60 + m;
}
/** Inside quiet hours right now? Windows may cross midnight (22:00-07:00). start == end means off. */
export function inQuietHours(prefs: NotifyPrefs, now = new Date()): boolean {
  const q = prefs.quiet;
  if (!q.on) return false;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const s = toMin(q.start), e = toMin(q.end), m = localMinutes(now, q.tz);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** The Notifications screen's test: no thread, no buttons, so it can't act on anything. */
export function buildTestPayload() {
  return {
    aps: { alert: { title: "Pocket", body: "Test notification: this is what Pocket notifications look like." }, sound: "default" },
    pocket: { kind: "test" },
  };
}

export function buildPayload(n: Notice, opts: { passive?: boolean } = {}) {
  const pocket: Record<string, unknown> = { threadId: n.threadId, kind: n.kind, forAt: n.forAt };
  if (n.interactionId) pocket.interactionId = n.interactionId;
  if (n.questionId) pocket.questionId = n.questionId;
  if (n.kind === "question") pocket.allowFreeText = n.allowFreeText === true;
  const choices = (n.choices ?? []).slice(0, CHOICES_MAX);
  if (choices.length) {
    pocket.choices = choices.map((c) => ({ label: c.label, text: c.text }));
    if (typeof n.recommended === "number" && n.recommended >= 0 && n.recommended < choices.length) pocket.recommended = n.recommended;
  }
  return {
    aps: {
      alert: { title: clip(n.title, TITLE_MAX), body: clip(n.body, BODY_MAX) },
      // Quiet hours: delivered to Notification Center without sound or waking the screen.
      ...(opts.passive ? { "interruption-level": "passive" } : { sound: "default" }),
      "thread-id": n.threadId,
      category: CATEGORY[n.kind],
      "mutable-content": 1,
    },
    pocket,
  };
}

export function apnsHeaders(topic: string, threadId: string, jwt: string): Record<string, string> {
  return {
    authorization: `bearer ${jwt}`,
    "apns-push-type": "alert",
    "apns-topic": topic,
    "apns-collapse-id": threadId,
    "apns-priority": "10",
  };
}

export const APNS_HOST = { sandbox: "https://api.sandbox.push.apple.com", production: "https://api.push.apple.com" } as const;

/** A payload safe for the log: body and choice texts cut short. */
export function redacted(payload: ReturnType<typeof buildPayload>) {
  const cut = (s: string) => clip(s, 40);
  const pocket = { ...payload.pocket } as Record<string, any>;
  if (Array.isArray(pocket.choices)) pocket.choices = pocket.choices.map((c: Choice) => ({ label: c.label, text: cut(c.text) }));
  return { aps: { ...payload.aps, alert: { title: payload.aps.alert.title, body: cut(payload.aps.alert.body) } }, pocket };
}

/** Drop the device: APNs says the token is gone or was never valid. */
export function isDeadToken(status: number, reason: string | undefined): boolean {
  return status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic";
}

// ---- the provider token --------------------------------------------------

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** An APNs provider token: ES256 JWT with `kid` in the header and `iss`/`iat` claims. */
export function apnsJwt(key: KeyObject | string, keyId: string, teamId: string, iatSec: number): string {
  const k = typeof key === "string" ? createPrivateKey(key) : key;
  const head = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: iatSec }));
  // JOSE wants the raw r||s signature, not DER.
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: k, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64url(sig)}`;
}

/** Apple accepts a token for an hour and rejects refreshing more than every 20 minutes. */
export const JWT_TTL_MS = 40 * 60_000;
