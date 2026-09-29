// bb-plugin-pocket — a deliberately small phone view of bb.
//
// The full bb web app works on a phone, but it is the desktop app squeezed
// down. Pocket keeps the jobs a phone is for: talk to the manager, triage
// what needs you, glance at what got made. Everything else stays in full bb.
//
// The page is one static HTML file served from GET /app. It talks to this
// server over plugin RPC (same origin, local auth), so there is no build step
// and no second login.
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { connect as h2connect, constants as h2, type ClientHttp2Session } from "node:http2";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize } from "node:path";
import { parseEnv } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  APNS_HOST, JWT_TTL_MS, RateLimit, UNSAFE_PILL, apnsHeaders, apnsJwt, buildPayload, buildTestPayload, describeApproval, emptyState,
  inQuietHours, interactionNotice, isDeadToken, normalizePrefs, plainText, redacted, replyChoices, safePill, verdict,
  type Choice, type Notice, type NotifState, type NotifyPrefs,
} from "./notify.ts";

const threadRow = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  status: z.string(),
  unread: z.boolean(),
  pending: z.boolean(),
  pinned: z.boolean(),
  manager: z.boolean(),
  child: z.boolean(),
  updatedAt: z.number(),
  preview: z.string().nullable(),
  hostId: z.string().nullable(),
  // He swiped it away: out of Needs you until the agent says something new.
  dismissed: z.boolean(),
  // Set once the thread has gone stale on you: Sol's single recommended reply.
  rec: z.object({ label: z.string(), text: z.string(), reason: z.string(), stake: z.string() }).nullable(),
});

const message = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  at: z.number(),
  // Files sent with the message (project attachments), shown under your bubble.
  files: z.array(z.object({ path: z.string(), name: z.string(), image: z.boolean() })).optional(),
  // "queued": held in bb's queue, not yet sent to the agent; note says why.
  state: z.enum(["queued"]).optional(),
  note: z.string().nullable().optional(),
});

// A file picked in Pocket travels inside the send itself and is uploaded to the
// thread's project on the server, so the page never names a server path.
const upFile = z.object({ name: z.string().min(1).max(200), mime: z.string().max(100), data: z.string().min(1).max(34_000_000) });
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
// Where page.html loads talk.js; GET /app puts the file inline there.
export const TALK_TAG = '<script src="./talk.js"></script>';

const choice = z.object({ label: z.string(), value: z.string(), description: z.string().nullable() });

// Only the two interaction shapes a thumb can answer. Anything else is
// reported as `other` and the page links to full bb.
const interaction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    id: z.string(),
    summary: z.string(),
    detail: z.string().nullable(),
    canAllowForSession: z.boolean(),
  }),
  z.object({
    kind: z.literal("question"),
    id: z.string(),
    questions: z.array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        multiSelect: z.boolean(),
        allowFreeText: z.boolean(),
        options: z.array(choice),
      }),
    ),
  }),
  z.object({ kind: z.literal("other"), id: z.string() }),
]);

const artifact = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  target: z.string(),
  isFile: z.boolean(),
  at: z.number(),
  source: z.enum(["tray", "thread"]),
  threadId: z.string().nullable(),
  threadTitle: z.string().nullable(),
  seen: z.boolean(),
  primary: z.boolean(),
});

const threadId = z.string().regex(/^thr_[a-z0-9]+$/);
const ok = z.object({ ok: z.boolean() });
// How the phone opens a Gmail draft: "app" just opens the Gmail app (the only
// link known to work); the rest are candidates tried on #/draft-links. None of
// them composes, so none can duplicate or send a draft.
const GMAIL_LINKS = ["app", "cv0", "cv1", "cvMail", "tlDrafts", "mweb"] as const;

export const rpcContract = defineRpcContract({
  home: {
    input: z.null(),
    output: z.object({
      threads: z.array(threadRow),
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
      managerId: z.string().nullable(),
      // True when you picked the manager yourself (long press), false when automatic.
      managerChosen: z.boolean(),
      newArtifacts: z.number(),
      // Walk needs the Talk to BB plugin (its live voice session).
      walk: z.boolean(),
      machines: z.array(z.object({ id: z.string(), name: z.string(), online: z.boolean() })),
    }),
  },
  thread: {
    input: z.object({ threadId }),
    output: z.object({
      id: z.string(),
      projectId: z.string(),
      projectName: z.string(),
      title: z.string(),
      status: z.string(),
      unread: z.boolean(),
      pinned: z.boolean(),
      machine: z.object({ id: z.string(), name: z.string(), online: z.boolean() }).nullable(),
      exec: z.object({ providerId: z.string(), providerName: z.string(), model: z.string().nullable(), modelName: z.string().nullable(), reasoning: z.string().nullable(), access: z.string().nullable() }),
      rec: z.object({ forAt: z.number(), pills: z.array(z.object({ label: z.string(), text: z.string() })), recommended: z.number(), reason: z.string(), stake: z.string() }).nullable(),
      messages: z.array(message),
      interactions: z.array(interaction),
    }),
  },
  send: {
    input: z.object({ threadId, text: z.string().trim().max(20000), files: z.array(upFile).max(10).optional() })
      .refine((v) => v.text.length > 0 || (v.files?.length ?? 0) > 0, "Nothing to send"),
    output: z.object({ delivery: z.string() }),
  },
  start: {
    input: z.object({
      projectId: z.string().min(1), text: z.string().trim().min(1).max(20000),
      files: z.array(upFile).max(10).optional(),
      providerId: z.string().max(80).optional(), model: z.string().max(120).optional(), reasoningLevel: z.string().max(20).optional(),
      hostId: z.string().max(80).optional(), permissionMode: z.enum(["auto", "full"]).optional(),
    }),
    output: z.object({ threadId: z.string() }),
  },
  approve: {
    input: z.object({
      threadId,
      interactionId: z.string(),
      decision: z.enum(["allow_once", "allow_for_session", "deny"]),
    }),
    output: ok,
  },
  answer: {
    input: z.object({
      threadId,
      interactionId: z.string(),
      answers: z.record(
        z.string(),
        z.object({ selected: z.array(z.string()), freeText: z.string().optional() }),
      ),
    }),
    output: ok,
  },
  stop: { input: z.object({ threadId }), output: ok },
  // Reading is explicit in Pocket: opening a thread is a peek and leaves it
  // unread. A swipe on the list (or the thread menu) is what marks it read.
  setRead: { input: z.object({ threadId, read: z.boolean() }), output: ok },
  setPinned: { input: z.object({ threadId, pinned: z.boolean() }), output: ok },
  done: {
    input: z.object({ threadId }),
    // Archiving a parent archives its live children too, so Pocket refuses
    // and says why rather than doing that silently from a phone.
    output: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  },
  transcribe: {
    // ~12 MB of base64 is several minutes of compressed speech.
    // `heard`: frames the page's level meter judged speech-loud (~60/s).
    input: z.object({ audio: z.string().min(1).max(28_000_000), mime: z.string().max(100), heard: z.number().int().min(0).max(1_000_000).optional() }),
    output: z.object({ text: z.string() }),
  },
  artifacts: {
    input: z.null(),
    output: z.object({ items: z.array(artifact) }),
  },
  // One diagnostic line per recording from the page (no audio, no text).
  voiceLog: {
    input: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).refine((o) => Object.keys(o).length <= 30),
    output: ok,
  },
  // "Tell bb": an iOS Shortcut dictates natively, then opens Pocket with the
  // text and a secret key. Only a link carrying the key auto-sends; anything
  // else lands in the review sheet. (getbb.app admits no non-browser requests,
  // so the Shortcut can't call bb directly.)
  shortcutKey: {
    input: z.object({ rotate: z.boolean().optional() }),
    output: z.object({ key: z.string() }),
  },
  tell: {
    input: z.object({ key: z.string().max(100), text: z.string().trim().min(1).max(20000) }),
    output: z.object({ ok: z.boolean(), reason: z.string().nullable(), threadId: z.string().nullable(), title: z.string().nullable(), delivery: z.string().nullable() }),
  },
  // Drafts waiting for you to send. Pocket never sends: it shows the draft
  // and opens Gmail or Slack, where you send it yourself.
  drafts: {
    input: z.object({ fresh: z.boolean().optional() }),
    output: z.object({
      enabled: z.boolean(),
      gmail: z.array(z.object({
        id: z.string(), hexId: z.string(), threadId: z.string(), to: z.string(), subject: z.string(), snippet: z.string(),
        at: z.number(), agent: z.boolean(), older: z.number(),
      })),
      slack: z.array(z.object({
        key: z.string(), target: z.string(), channel: z.string(), thread: z.string().nullable(), text: z.string(), at: z.number(),
      })),
      teamId: z.string().nullable(),
      gmailError: z.string().nullable(),
      // Which link the phone uses for a Gmail draft (picked on #/draft-links), and the
      // signed-in address for the links that name the account.
      gmailLink: z.enum(GMAIL_LINKS),
      account: z.string().nullable(),
    }),
  },
  draftBody: {
    input: z.object({ id: z.string().regex(/^r-?\d+$/) }),
    output: z.object({ to: z.string(), cc: z.string(), subject: z.string(), body: z.string() }),
  },
  dismissDraft: { input: z.object({ key: z.string().max(100) }), output: ok },
  setGmailLink: { input: z.object({ style: z.enum(GMAIL_LINKS) }), output: ok },
  // Quick replies: tappable suggestions under the agent's latest message.
  // Which pills you actually tap: the one-week test of "more opinionated when stale".
  // Long swipe left in Needs you: mark read and keep it out of Needs you (and
  // unrecommended) until the agent's next message. `undo` reverses it.
  dismiss: { input: z.object({ threadId, undo: z.boolean().optional(), wasUnread: z.boolean().optional() }), output: ok },
  // For the one-week readout (automation): what Sol recommended, and what you did.
  // Model picker: every provider's models (with the reasoning levels each
  // supports), a project's defaults and the machines it can run on, and a
  // model change on an existing thread.
  catalog: {
    input: z.null(),
    output: z.object({ providers: z.array(z.object({ id: z.string(), name: z.string(), models: z.array(z.object({ id: z.string(), name: z.string(), isDefault: z.boolean(), efforts: z.array(z.string()), defaultEffort: z.string().nullable().optional() })) })) }),
  },
  projectSetup: {
    input: z.object({ projectId: z.string().min(1) }),
    output: z.object({
      defaults: z.object({ providerId: z.string().nullable(), model: z.string().nullable(), reasoningLevel: z.string().nullable() }),
      machines: z.array(z.object({ hostId: z.string(), name: z.string(), online: z.boolean(), isDefault: z.boolean() })),
    }),
  },
  setModel: { input: z.object({ threadId, model: z.string().max(120), reasoningLevel: z.string().max(20).optional() }), output: ok },
  // Auto / Full access for an existing thread. bb takes access per message, so
  // Pocket remembers the choice and sends it with every message to that thread.
  setAccess: { input: z.object({ threadId, mode: z.enum(["auto", "full"]) }), output: ok },
  rename: { input: z.object({ threadId, title: z.string().trim().min(1).max(200) }), output: ok },
  // ✨ in Rename: a short descriptive title from how the thread started and where it is.
  suggestTitle: { input: z.object({ threadId }), output: z.object({ title: z.string() }) },
  // Thread mentions in messages (@thread:thr_…, bare thr_… ids) become chips
  // with the thread's title. Unknown ids come back found:false.
  threadRefs: {
    input: z.object({ ids: z.array(threadId).max(60) }),
    output: z.object({
      threads: z.array(z.object({ id: z.string(), found: z.boolean(), title: z.string(), projectName: z.string(), archived: z.boolean() })),
    }),
  },
  // File links in messages ([label](docs/x.png), absolute paths, thread-storage:…).
  // Relative paths resolve against the thread's environment. ok:false = not a
  // file link Pocket can open; found:null = on another machine, not checked.
  fileRefs: {
    input: z.object({ threadId, paths: z.array(z.string().min(1).max(1000)).max(40) }),
    output: z.object({
      files: z.array(z.object({ path: z.string(), ok: z.boolean(), found: z.boolean().nullable(), kind: z.string(), name: z.string() })),
    }),
  },
  // A markdown file's text, for Pocket's own viewer.
  fileText: {
    input: z.object({ threadId, path: z.string().min(1).max(1000) }),
    output: z.object({ found: z.boolean(), name: z.string(), text: z.string(), truncated: z.boolean() }),
  },
  // Long press → "Make this the manager": where the home mic and the Shortcut send. null = automatic.
  setManager: { input: z.object({ threadId: threadId.nullable() }), output: ok },
  // Universal search: threads (titles and messages, archived included, via
  // bb's own index) plus artifacts by name.
  search: {
    input: z.object({ query: z.string().trim().min(1).max(200) }),
    output: z.object({
      threads: z.array(z.object({
        id: z.string(), title: z.string(), projectName: z.string(), archived: z.boolean(), updatedAt: z.number(),
        snippet: z.string().nullable(), ranges: z.array(z.tuple([z.number(), z.number()])), where: z.string(),
      })),
      artifacts: z.array(artifact),
    }),
  },
  pillStats: {
    input: z.object({ sinceDays: z.number().min(1).max(60).optional() }),
    output: z.object({ summary: z.record(z.string(), z.number()), recs: z.array(z.record(z.string(), z.unknown())), taps: z.array(z.record(z.string(), z.unknown())) }),
  },
  pillLog: {
    input: z.object({ threadId, label: z.string().max(60), recommended: z.boolean(), stale: z.boolean(), source: z.enum(["home", "thread"]) }),
    output: ok,
  },
  suggest: {
    input: z.object({ threadId }),
    output: z.object({ forAt: z.number(), pills: z.array(z.object({ label: z.string(), text: z.string() })) }),
  },
  // Swipe right in a thread: just what that thread produced or linked.
  threadArtifacts: {
    input: z.object({ threadId }),
    output: z.object({ items: z.array(artifact) }),
  },
  artifactsSeen: {
    input: z.object({ ids: z.array(z.string().max(40)).max(500) }),
    output: ok,
  },
  // The Pocket iOS app registers its APNs device token here (on every launch;
  // re-registering the same token just refreshes lastSeen).
  registerDevice: {
    input: z.object({ token: z.string().regex(/^[0-9a-fA-F]{32,200}$/), env: z.enum(["sandbox", "production"]), bundleId: z.string().min(1).max(200) }),
    output: ok,
  },
  // Sends one TEST notification to every registered device (or logs it, in a
  // dry run) and says what APNs answered. It names no thread and has no
  // buttons, so it can never act on a thread. `threadId` is accepted and ignored.
  testNotification: {
    input: z.object({ threadId: threadId.optional() }).nullable(),
    output: z.object({
      dryRun: z.boolean(),
      devices: z.number(),
      results: z.array(z.object({ device: z.string(), env: z.string(), status: z.number(), reason: z.string().nullable() })),
      payload: z.string(),
    }),
  },
  // The Notifications screen: where push stands, your settings, the devices.
  notifyStatus: {
    input: z.null(),
    output: z.object({
      serverOn: z.boolean(),   // the plugin's `notifications` setting (bb plugin config)
      keyReady: z.boolean(),   // an APNs key, key id and team id are set
      dryRun: z.boolean(),     // nothing leaves the server: logged only
      quietNow: z.boolean(),
      prefs: z.object({
        kinds: z.object({ approval: z.boolean(), question: z.boolean(), reply: z.boolean() }),
        quiet: z.object({ on: z.boolean(), start: z.string(), end: z.string(), tz: z.string() }),
      }),
      devices: z.array(z.object({ id: z.string(), env: z.string(), bundleId: z.string(), matches: z.boolean(), addedAt: z.number(), lastSeen: z.number() })),
    }),
  },
  setNotifyPrefs: {
    input: z.object({
      kinds: z.object({ approval: z.boolean(), question: z.boolean(), reply: z.boolean() }),
      quiet: z.object({ on: z.boolean(), start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), tz: z.string().min(1).max(64) }),
    }),
    output: ok,
  },
  // Forget a registered device (by the last 6 characters of its token, as shown).
  forgetDevice: { input: z.object({ id: z.string().regex(/^[0-9a-f]{6}$/) }), output: ok },
  // About & what's new: this plugin's version and changelog, and the iPhone
  // app's changelog if its path is configured (the page compares it with the
  // installed build the app reports over the bridge).
  about: {
    input: z.null(),
    output: z.object({ pocketVersion: z.string(), pocketChangelog: z.string(), iosChangelog: z.string().nullable() }),
  },
});

// The fields Pocket reads; both the list and get DTOs carry them.
type Dto = {
  id: string;
  projectId: string;
  status: string;
  title?: string | null;
  titleFallback?: string | null;
  runtime?: { displayStatus: string } | null;
  latestAttentionAt?: number | null;
  lastReadAt?: number | null;
  updatedAt: number;
  pinnedAt?: number | null;
  pinSortKey?: string | null;
  parentThreadId?: string | null;
  hasPendingInteraction?: boolean;
  environmentPath?: string | null;
  environmentHostId?: string | null;
};

const TITLE_MAX = 90;
const PREVIEW_MAX = 160;
const PREVIEW_FETCH_MAX = 12;
const MESSAGES_MAX = 40;
const DAY = 86_400_000;

// Posts the mic as 20 ms Int16 chunks and outputs silence. It is wired to the
// context's destination only so the graph keeps being pulled.
const CAPTURE_WORKLET = `class PocketCapture extends AudioWorkletProcessor {
  constructor() { super(); this.size = Math.round(sampleRate / 50); this.buf = new Int16Array(this.size); this.used = 0; }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this.buf[this.used++] = Math.round(s * (s < 0 ? 32768 : 32767));
      if (this.used === this.size) {
        // Transferring detaches the buffer (its length reads 0), so size comes from this.size.
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(this.size); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor("pocket-capture", PocketCapture);
`;

// Titles for thread mention chips. Titles change (rename, auto-title), so
// entries expire; a miss is retried sooner in case the thread was just made.
const REF_TTL = 5 * 60_000;
const REF_MISS_TTL = 60_000;
const refCache = new Map<string, { at: number; ref: { id: string; found: boolean; title: string; projectName: string; archived: boolean } }>();

// bb returns preview URLs on the server's own address (127.0.0.1 here); only
// the path is portable, so redirects stay on whatever origin the phone used.
function previewPath(baseUrl: string): string {
  try { return new URL(baseUrl).pathname.replace(/\/$/, ""); } catch { return baseUrl.replace(/\/$/, ""); }
}

function titleOf(t: { title?: string | null; titleFallback?: string | null }): string {
  const raw = (t.title || t.titleFallback || "Untitled").replace(/\s+/g, " ").trim();
  return raw.length > TITLE_MAX ? `${raw.slice(0, TITLE_MAX - 1)}…` : raw;
}

const isWorking = (s: string) => s === "active" || s === "running" || s === "starting";

function statusOf(t: Dto): string {
  return t.runtime?.displayStatus ?? t.status;
}

function isUnread(t: Dto): boolean {
  return (t.latestAttentionAt ?? 0) > (t.lastReadAt ?? 0);
}

function lastActive(t: Dto): number {
  return Math.max(t.latestAttentionAt ?? 0, t.updatedAt ?? 0);
}

function stripMd(line: string): string {
  return line.replace(/^[#>*\-\s\d.]+/, "").replace(/[*_`]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
}

/** First meaningful line of markdown, stripped to plain text. */
function previewOf(text: string): string | null {
  const line = text.split("\n").map(stripMd).find((l) => l.length > 0);
  if (!line) return null;
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

// ---------------------------------------------------------------------------
// Artifacts: things made for the user, pulled from two places. The tray ledger
// is what agents declared on purpose; agents' own replies catch everything
// they linked but never declared (most Google Docs).

type Found = { key: string; kind: string; label: string; target: string; isFile: boolean; at: number; hostId: string | null };

const KEEP_HOSTS = [
  /(^|\.)docs\.google\.com$/,
  /(^|\.)drive\.google\.com$/,
  /(^|\.)loom\.com$/,
  /(^|\.)figma\.com$/,
  /(^|\.)canva\.com$/,
  /\.netlify\.app$/,
  /\.vercel\.app$/,
  /--\d+\.getbb\.app$/,
];
const FILE_KINDS: Record<string, string> = {
  ".html": "page", ".htm": "page", ".pdf": "pdf",
  ".docx": "doc", ".doc": "doc", ".pptx": "slides", ".key": "slides", ".xlsx": "sheet", ".csv": "sheet",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image", ".avif": "image",
  ".mp4": "video", ".mov": "video", ".m4a": "audio", ".mp3": "audio", ".md": "note",
};

function urlKind(u: URL): string {
  if (u.hostname.endsWith("docs.google.com")) {
    if (u.pathname.startsWith("/spreadsheets")) return "sheet";
    if (u.pathname.startsWith("/presentation")) return "slides";
    if (u.pathname.startsWith("/forms")) return "form";
    return "doc";
  }
  if (u.hostname.endsWith("drive.google.com")) return "drive";
  if (u.hostname.endsWith("loom.com")) return "video";
  if (u.hostname.endsWith("figma.com") || u.hostname.endsWith("canva.com")) return "design";
  return "link";
}

const KIND_NAMES: Record<string, string> = {
  doc: "Google Doc", sheet: "Sheet", slides: "Slides", form: "Form", drive: "Drive file",
  video: "Video", design: "Design", link: "Link", page: "Page", pdf: "PDF", image: "Image", audio: "Audio", note: "Note",
};

/** Keep only what a person would want to open; reject code, config, and scratch. */
// Notes and images are everywhere in agent replies (references, screenshots
// of their own work). They count only when an agent linked one *for you*:
// a markdown link, or a tray entry.
const NEEDS_LINK = new Set(["note", "image", "audio"]);

function classify(raw: string, envPath: string | null, linked = true): { key: string; kind: string; target: string; isFile: boolean } | null {
  let target = raw.trim().replace(/[.,;:!?]+$/, "");
  if (/^https?:\/\//i.test(target)) {
    let u: URL;
    try { u = new URL(target); } catch { return null; }
    if (!KEEP_HOSTS.some((re) => re.test(u.hostname))) return null;
    const kind = urlKind(u);
    const g = u.pathname.match(/\/d\/([A-Za-z0-9_-]{20,})/);
    const key = g ? `g:${g[1]}` : `u:${u.origin}${u.pathname.replace(/\/$/, "")}${u.search}`;
    return { key, kind, target: u.toString(), isFile: false };
  }
  target = target.replace(/^file:\/\//, "").replace(/#.*$/, "").replace(/:\d+(:\d+)?$/, "");
  try { target = decodeURIComponent(target); } catch { /* keep as-is */ }
  if (target.startsWith("~/")) target = join(homedir(), target.slice(2));
  else if (!isAbsolute(target)) {
    if (!envPath || target.startsWith("..") || /^[a-z]+:/i.test(target)) return null;
    target = join(envPath, target);
  }
  target = normalize(target);
  const ext = extname(target).toLowerCase();
  const kind = FILE_KINDS[ext];
  if (!kind || (!linked && NEEDS_LINK.has(kind))) return null;
  if (/^\/(tmp|private\/tmp|var\/folders)\//.test(target)) return null;
  // Markdown is everywhere (memory, handoffs, skills); only docs/ is a deliverable.
  if (ext === ".md" && (!/\/docs\//.test(target) || /\/(memory|handoffs|skills)\//.test(target))) return null;
  if (/\/(node_modules|\.git|dist|test|tests|fixtures)\//.test(target) || /\/\.bb\/worktrees\//.test(target)) return null;
  return { key: `f:${target}`, kind, target, isFile: true };
}

function extractFrom(text: string, at: number, envPath: string | null, hostId: string | null): Found[] {
  const out = new Map<string, Found>();
  const lines = text.split("\n");
  const lineAt = (index: number) => {
    let n = 0;
    for (const line of lines) {
      if (index <= n + line.length) return line;
      n += line.length + 1;
    }
    return "";
  };
  const add = (raw: string, label: string | null, index: number) => {
    const c = classify(raw, envPath, label !== null);
    if (!c || out.has(c.key)) return;
    let name = label?.replace(/[`*_]/g, "").trim() || "";
    if (!name || name === raw || /^https?:\/\//.test(name)) {
      const context = stripMd(lineAt(index).replace(raw, "")).replace(/\s*[:—–-]\s*$/, "").replace(/\(\s*\)|\[\s*\]/g, "").trim();
      name = c.isFile ? basename(c.target) : context.length >= 4 ? context : KIND_NAMES[c.kind] ?? "Link";
    }
    if (name.length > 90) name = `${name.slice(0, 89)}…`;
    out.set(c.key, { ...c, label: name, at, hostId: c.isFile ? hostId : null });
  };
  for (const m of text.matchAll(/\[([^\]\n]{1,200})\]\(([^)\s]+)\)/g)) add(m[2], m[1], m.index ?? 0);
  for (const m of text.matchAll(/https?:\/\/[^\s<>)\]"'`]+/g)) add(m[0], null, m.index ?? 0);
  for (const m of text.matchAll(/`((?:~\/|\/)[^`\s]+\.[A-Za-z0-9]{2,5})`/g)) add(m[1], null, m.index ?? 0);
  return [...out.values()];
}

// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  // Everything specific to one person's setup is a setting. Without an OpenAI
  // key Pocket still works: voice uses bb's own transcription, quick replies
  // fall back to yes/no detection, and stale-thread recommendations are off.
  const settings = bb.settings.define({
    openaiApiKey: {
      type: "string", secret: true,
      label: "OpenAI API key",
      description: "Used for voice transcription, quick-reply pills, and stale-thread recommendations. Optional: without it voice uses bb's own transcription and the AI pills are off.",
    },
    openaiCredentialFile: {
      type: "string",
      label: "…or an env file on the bb server holding OPENAI_API_KEY",
      description: "Used only when the key above is empty.",
      default: "",
    },
    userName: {
      type: "string",
      label: "Your first name",
      description: "Used in the prompts that suggest replies on your behalf.",
      default: "",
    },
    vocabulary: {
      type: "string",
      label: "Names to spell right in voice notes",
      description: "Comma-separated proper nouns (clients, teammates, tools) passed to the transcriber as a hint.",
      default: "",
    },
    vocabularyFile: {
      type: "string",
      label: "…or a markdown file of names",
      description: "Optional. Bold words in the second column of any markdown table are used as names.",
      default: "",
    },
    managerSkill: {
      type: "string",
      label: "Manager skill name",
      description: "The home mic sends to the most recent top-level thread that started with /<skill> or loaded this skill. Leave as is if you don't use one; you'll pick a thread instead.",
      default: "bb-manager",
    },
    recommendations: {
      type: "boolean",
      label: "Opinionated recommendations on stale threads",
      description: "When you leave an agent's message unanswered (30 min after seeing it, 2 h unseen), a stronger model picks one reply with a reason. Needs the OpenAI key.",
      default: true,
    },
    suggestModel: { type: "string", label: "Model for quick-reply pills", default: "gpt-5.6-luna" },
    recommendModel: { type: "string", label: "Model for stale-thread recommendations", default: "gpt-6-sol" },
    transcribeModel: { type: "string", label: "Model for voice transcription", default: "gpt-4o-transcribe" },
    trayLedger: {
      type: "string",
      label: "Artifacts: extra JSONL ledger (optional)",
      description: "One {ts, target, label} per line. Artifacts already come from links and files agents mention; this adds items declared on purpose.",
      default: "",
    },
    gmailDrafts: {
      type: "boolean",
      label: "Drafts: list Gmail drafts",
      description: "Needs the gws CLI (Google Workspace CLI) signed in on the bb server.",
      default: false,
    },
    gwsPath: { type: "string", label: "Drafts: path to gws", default: "gws" },
    gwsEnv: {
      type: "string",
      label: "Drafts: extra environment for gws",
      description: "Optional KEY=value pairs separated by spaces, e.g. GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file",
      default: "",
    },
    slackDraftsLog: {
      type: "string",
      label: "Drafts: Slack draft log (JSONL, optional)",
      description: "Slack won't list drafts, so this reads a log your tools append to: {ts, channel, target, thread, text, draft_id} per line.",
      default: "",
    },
    slackEnvFile: {
      type: "string",
      label: "Drafts: env file with SLACK_USER_TOKEN (optional)",
      description: "Lets Pocket drop a Slack draft once you've sent a matching message.",
      default: "",
    },
    notifications: {
      type: "boolean",
      label: "Notifications: push to the Pocket iOS app",
      description: "Approvals, questions, and agent replies that need you, sent to the Pocket app through Apple Push. Needs the APNs key below.",
      default: false,
    },
    notificationsDryRun: {
      type: "boolean",
      label: "Notifications: dry run",
      description: "Log what would be sent instead of sending. Also in effect while the APNs key, key id or team id is missing.",
      default: true,
    },
    apnsKeyFile: { type: "string", label: "Notifications: APNs key file (.p8) on the bb server", default: "" },
    apnsKeyId: { type: "string", label: "Notifications: APNs key id", description: "The 10-character Key ID shown next to the key in Apple's developer portal.", default: "" },
    apnsTeamId: { type: "string", label: "Notifications: Apple team id", default: "" },
    apnsBundleId: {
      type: "string",
      label: "Notifications: app bundle id (optional)",
      description: "When set, only devices registered by this app get notifications. Empty: each device's own bundle id is used.",
      default: "",
    },
    iosChangelogFile: {
      type: "string",
      label: "iPhone app changelog (optional)",
      description: "Path on the bb server to the Pocket iPhone app's CHANGELOG.md. Pocket's About screen uses it to show what's built vs. installed.",
      default: "",
    },
  });
  const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

  // Path installs run server.ts from the package root; git/npm installs run
  // the built dist/server.js. Look beside the module first, then one level up.
  const asset = async (name: string) => {
    for (const rel of [`./${name}`, `../${name}`]) {
      try { return await readFile(new URL(rel, import.meta.url)); } catch { /* next */ }
    }
    throw new Error(`${name} not found`);
  };

  async function projectNames(): Promise<Map<string, string>> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    return new Map(projects.map((p) => [p.id, p.id === "proj_personal" ? "Personal" : p.name]));
  }

  // ---- manager detection --------------------------------------------------
  // A manager thread either began with the /bb-manager slash command or loaded
  // the bb-manager skill mid-conversation. Search finds the candidates cheaply;
  // the skill case is confirmed from the thread's own tool-call events, and
  // that answer is cached with the last event scanned.
  const skillName = async () => ((await settings.get()).managerSkill || "").trim().replace(/^\//, "");
  const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let managerCache: { at: number; ids: Set<string> } | null = null;

  let managerRe = /(^|:)bb-manager$/;
  async function skillScan(id: string): Promise<boolean> {
    const key = `mgr:${id}`;
    const cached = (await bb.storage.kv.get<{ seq: number; hit: boolean }>(key)) ?? { seq: 0, hit: false };
    if (cached.hit) return true;
    let seq = cached.seq;
    let hit = false;
    // bb caps an event page at 100; long threads take a few pages once, then
    // only the new tail is read on later passes.
    for (let page = 0; page < 150 && !hit; page++) {
      const events = (await bb.sdk.threads.events.list({
        threadId: id,
        types: ["item/started"],
        order: "asc",
        limit: "100",
        ...(seq ? { afterSeq: String(seq) } : {}),
      })) as unknown as Array<{ seq: number; data?: { item?: { tool?: string; arguments?: { skill?: string } } } }>;
      for (const e of events) {
        seq = Math.max(seq, e.seq);
        const item = e.data?.item;
        if (item?.tool === "Skill" && managerRe.test(String(item.arguments?.skill ?? ""))) hit = true;
      }
      if (events.length < 100) break;
    }
    await bb.storage.kv.set(key, { seq, hit });
    return hit;
  }

  // Your messages bb is holding in its queue: sent while the thread was busy,
  // scheduled with sendAt, or held by the concurrency limit ("4 of 4
  // running"). The timeline only has a message once it's released, which can
  // be minutes, so a queued send looked lost and got sent again (B33).
  async function queuedMine(threadId: string): Promise<z.infer<typeof message>[]> {
    const textOf = (parts: unknown) => {
      const list = Array.isArray(parts) ? parts : [];
      const text = list.map((p: any) => (p?.type === "text" && typeof p.text === "string" ? p.text : "")).join("\n").trim();
      return text || (list.length ? "(attachment)" : "");
    };
    const queued = (await bb.sdk.threads.queuedMessages.list({ threadId }).catch(() => [])) as unknown as Array<any>;
    const out: z.infer<typeof message>[] = [];
    for (const q of queued) {
      if (q?.initiator !== "user") continue;
      const text = textOf(q.content);
      if (!text) continue;
      const note = q.waitingOn?.reason ?? (q.sendAt ? `Sends at ${new Date(q.sendAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : null);
      out.push({ role: "user", text, at: q.createdAt ?? Date.now(), state: "queued", note: note ? String(note) : null });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  async function managerIds(): Promise<Set<string>> {
    if (managerCache && Date.now() - managerCache.at < 60_000) return managerCache.ids;
    const ids = new Set<string>();
    const skill = await skillName();
    if (!skill) { managerCache = { at: Date.now(), ids }; return ids; }
    managerRe = new RegExp(`(^|:)${escRe(skill)}$`);
    const slashRe = new RegExp(`^\\s*/${escRe(skill)}\\b`);
    const res = (await bb.sdk.threads.search({ query: skill, limitPerGroup: "40" })) as any;
    const results: Array<{ thread: Dto & { archivedAt: number | null }; matches: Array<{ sourceKind: string; text: string }> }> =
      res?.active?.results ?? [];
    await Promise.all(
      results
        .filter((r) => !r.thread.parentThreadId && !r.thread.archivedAt)
        .map(async (r) => {
          const slash = r.matches.some(
            (m) => (m.sourceKind === "user_message" || m.sourceKind === "title_fallback") && slashRe.test(m.text),
          );
          if (slash) return ids.add(r.thread.id);
          try {
            if (await skillScan(r.thread.id)) ids.add(r.thread.id);
          } catch (e) {
            bb.log.warn(`manager scan ${r.thread.id}: ${e instanceof Error ? e.message : e}`);
          }
        }),
    );
    managerCache = { at: Date.now(), ids };
    return ids;
  }

  // ---- transcription ------------------------------------------------------
  // Proper nouns passed to the transcriber so names come out right. Returns
  // "" when none are configured (no hint beats a generic one).
  async function vocabularyHint(): Promise<string> {
    const { vocabulary, vocabularyFile } = await settings.get();
    const names = new Set(["bb"]);
    for (const n of (vocabulary || "").split(",")) if (n.trim()) names.add(n.trim());
    if (vocabularyFile) {
      try {
        const md = await readFile(expandHome(vocabularyFile), "utf8");
        // e.g. a corrections table whose second column holds the canonical spelling in bold.
        for (const m of md.matchAll(/^\|[^|\n]*\|\s*\*\*([^*|]{2,40})\*\*/gm)) names.add(m[1].trim());
      } catch { /* optional */ }
    }
    return names.size > 1 ? `Proper nouns that may come up: ${[...names].join(", ")}.`.slice(0, 900) : "";
  }

  async function openaiKey(): Promise<string | null> {
    const { openaiApiKey, openaiCredentialFile } = await settings.get();
    if (openaiApiKey?.trim()) return openaiApiKey.trim();
    if (!openaiCredentialFile) return null;
    try {
      return parseEnv(await readFile(expandHome(openaiCredentialFile), "utf8")).OPENAI_API_KEY || null;
    } catch {
      return null;
    }
  }
  const who = async () => ((await settings.get()).userName || "").trim() || "the user";

  // Given silence, the transcriber tends to recite its vocabulary hint back
  // (a list of client and teammate names). A transcript that is mostly hint words,
  // or the hint's own lead-in, is treated as nothing heard.
  function echoesHint(text: string, hint: string): boolean {
    const t = text.toLowerCase();
    if (!t.trim()) return true;
    if (t.includes("proper nouns") || t.includes("may come up")) return true;
    const words = t.match(/[a-z0-9'-]+/g) ?? [];
    if (words.length === 0) return true;
    const hintWords = new Set(hint.toLowerCase().match(/[a-z0-9'-]+/g) ?? []);
    const inHint = words.filter((w) => hintWords.has(w)).length;
    return words.length >= 3 && inHint / words.length > 0.6;
  }

  function audioFile(bytes: Buffer, mime: string): File {
    const base = mime.split(";")[0].trim().toLowerCase();
    const ext = base.includes("mp4") || base.includes("m4a") || base.includes("aac") ? "m4a"
      : base.includes("webm") ? "webm" : base.includes("ogg") ? "ogg" : base.includes("mpeg") ? "mp3" : base.includes("wav") ? "wav" : "m4a";
    return new File([new Uint8Array(bytes)], `voice.${ext}`, { type: base || "audio/mp4" });
  }

  // ---- artifacts ----------------------------------------------------------
  type Merged = Found & { id: string; source: "tray" | "thread"; threadId: string | null; threadTitle: string | null };
  let artifactCache: { at: number; items: Merged[] } | null = null;
  let artifactRun: Promise<Merged[]> | null = null;

  async function readTray(): Promise<Found[]> {
    const { trayLedger } = await settings.get();
    let text: string;
    if (!trayLedger) return [];
    try { text = await readFile(expandHome(trayLedger), "utf8"); } catch { return []; }
    const out: Found[] = [];
    for (const line of text.trim().split("\n").slice(-400)) {
      try {
        const e = JSON.parse(line) as { ts?: string; target?: string; label?: string };
        if (!e.target) continue;
        const c = classify(e.target, null) ?? (/^https?:\/\//.test(e.target)
          ? { key: `u:${e.target}`, kind: "link", target: e.target, isFile: false }
          : { key: `f:${e.target}`, kind: FILE_KINDS[extname(e.target).toLowerCase()] ?? "file", target: e.target, isFile: true });
        // Tray timestamps are naive local times written on this machine.
        const at = e.ts ? new Date(e.ts).getTime() : 0;
        out.push({ ...c, label: e.label || basename(c.target), at: Number.isFinite(at) ? at : 0, hostId: null });
      } catch { /* skip a bad line */ }
    }
    return out;
  }

  async function scanThreads(): Promise<Array<Found & { threadId: string; threadTitle: string }>> {
    const since = Date.now() - 14 * DAY;
    const [open, archived] = await Promise.all([
      bb.sdk.threads.list({ archived: false, limit: 300 }),
      bb.sdk.threads.list({ archived: true, limit: 150 }),
    ]);
    const threads = ([...open, ...archived] as Dto[]).filter((t) => t.updatedAt >= since);
    const out: Array<Found & { threadId: string; threadTitle: string }> = [];
    const queue = [...threads];
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const key = `art:v2:t:${t.id}`; // bump the version when extraction rules change
        let entry = await bb.storage.kv.get<{ u: number; items: Found[] }>(key);
        if (!entry || entry.u !== t.updatedAt) {
          try {
            const timeline = await bb.sdk.threads.timeline({ threadId: t.id, segmentLimit: "30" });
            const found = new Map<string, Found>((entry?.items ?? []).map((f) => [f.key, f]));
            for (const row of timeline.rows as Array<Record<string, unknown>>) {
              if (row.kind !== "conversation" || row.role !== "assistant" || typeof row.text !== "string") continue;
              const at = typeof row.createdAt === "number" ? row.createdAt : t.updatedAt;
              for (const f of extractFrom(row.text, at, t.environmentPath ?? null, t.environmentHostId ?? null)) {
                const prev = found.get(f.key);
                if (!prev || f.at < prev.at) found.set(f.key, f);
              }
            }
            entry = { u: t.updatedAt, items: [...found.values()].sort((a, b) => b.at - a.at).slice(0, 60) };
            await bb.storage.kv.set(key, entry);
          } catch (e) {
            bb.log.warn(`artifact scan ${t.id}: ${e instanceof Error ? e.message : e}`);
            continue;
          }
        }
        for (const f of entry.items) out.push({ ...f, threadId: t.id, threadTitle: titleOf(t) });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return out;
  }

  async function buildArtifacts(): Promise<Merged[]> {
    const [tray, fromThreads] = await Promise.all([readTray(), scanThreads()]);
    const merged = new Map<string, Merged>();
    // Earliest mention wins the timestamp (when it was made); the tray's
    // deliberate label wins over one guessed from surrounding prose.
    for (const f of fromThreads) {
      const prev = merged.get(f.key);
      if (!prev || f.at < prev.at) merged.set(f.key, { ...f, id: sha(f.key), source: "thread" });
    }
    for (const f of tray) {
      const prev = merged.get(f.key);
      merged.set(f.key, {
        ...f,
        id: sha(f.key),
        source: "tray",
        at: prev ? Math.min(prev.at, f.at || prev.at) : f.at,
        hostId: prev?.hostId ?? null,
        threadId: prev?.threadId ?? null,
        threadTitle: prev?.threadTitle ?? null,
      });
    }
    return [...merged.values()].sort((a, b) => b.at - a.at).slice(0, 300);
  }

  async function artifacts(fresh = false): Promise<Merged[]> {
    if (!fresh && artifactCache && Date.now() - artifactCache.at < 45_000) return artifactCache.items;
    artifactRun ??= buildArtifacts()
      .then((items) => { artifactCache = { at: Date.now(), items }; return items; })
      .finally(() => { artifactRun = null; });
    return artifactRun;
  }

  // Per-thread artifacts, scanned on demand (any age, archived or not) and
  // indexed so /open can resolve them too.
  const threadArtifactIndex = new Map<string, Merged>();
  const threadArtifactCache = new Map<string, { u: number; items: Merged[] }>();
  async function artifactsForThread(threadId: string): Promise<Merged[]> {
    const t = (await bb.sdk.threads.get({ threadId })) as unknown as Dto;
    const hit = threadArtifactCache.get(threadId);
    if (hit && hit.u === t.updatedAt) return hit.items;
    // A single-thread lookup carries only the environment id; relative file
    // links need the environment's folder (and machine) to resolve.
    let envPath = t.environmentPath ?? null, envHost = t.environmentHostId ?? null;
    const envId = (t as unknown as { environmentId?: string | null }).environmentId;
    if (!envPath && envId) {
      try {
        const env = (await bb.sdk.environments.get({ environmentId: envId })) as unknown as { path?: string; hostId?: string };
        envPath = env.path ?? null; envHost = env.hostId ?? null;
      } catch { /* links that need it are skipped */ }
    }
    const tl = await bb.sdk.threads.timeline({ threadId, segmentLimit: "100" });
    const found = new Map<string, Found>();
    for (const row of tl.rows as Array<Record<string, unknown>>) {
      if (row.kind !== "conversation" || typeof row.text !== "string") continue;
      const at = typeof row.createdAt === "number" ? row.createdAt : t.updatedAt;
      for (const f of extractFrom(row.text, at, envPath, envHost)) {
        const prev = found.get(f.key);
        if (!prev || f.at < prev.at) found.set(f.key, f);
      }
    }
    const items = [...found.values()]
      .map((f) => ({ ...f, id: sha(f.key), source: "thread" as const, threadId, threadTitle: titleOf(t) }))
      .sort((a, b) => b.at - a.at);
    for (const m of items) threadArtifactIndex.set(m.id, m);
    threadArtifactCache.set(threadId, { u: t.updatedAt, items });
    return items;
  }

  async function seenSet(): Promise<Set<string>> {
    return new Set((await bb.storage.kv.get<string[]>("seen")) ?? []);
  }
  async function markSeen(ids: string[]) {
    const seen = await seenSet();
    for (const id of ids) seen.add(id);
    await bb.storage.kv.set("seen", [...seen].slice(-3000));
  }
  // "For you" is what an agent made to be opened: Google files, PDFs, pages,
  // sites, and anything declared to the tray. Notes and screenshots an agent
  // merely linked are kept, but only under Everything.
  const isPrimary = (a: Merged) => a.source === "tray" || !["note", "image", "audio", "file"].includes(a.kind);
  // Only the last day can be "new"; older items are history, not news.
  const isNew = (a: Merged, seen: Set<string>) => isPrimary(a) && a.at > Date.now() - DAY && !seen.has(a.id);

  // ---- drafts -------------------------------------------------------------
  // gws on this server (file keyring: see the gws-auth-recovery skill). A 403
  // comes back as an error here, never as an empty list.
  let gwsCfg = { path: "gws", env: {} as Record<string, string> };
  async function refreshGwsCfg() {
    const { gwsPath, gwsEnv } = await settings.get();
    const env: Record<string, string> = {};
    for (const pair of (gwsEnv || "").split(/\s+/)) { const i = pair.indexOf("="); if (i > 0) env[pair.slice(0, i)] = expandHome(pair.slice(i + 1)); }
    gwsCfg = { path: expandHome(gwsPath || "gws"), env };
  }
  function gws<T>(args: string[]): Promise<T> {
    return new Promise((resolve, reject) => {
      execFile(gwsCfg.path, args, {
        timeout: 20_000,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, ...gwsCfg.env },
      }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`gws: ${(stderr || err.message).trim().slice(0, 200)}`));
        try { resolve(JSON.parse(stdout) as T); } catch { reject(new Error("gws returned non-JSON")); }
      });
    });
  }

  type GmailDraft = { id: string; hexId: string; threadId: string; to: string; subject: string; snippet: string; at: number; agent: boolean };
  const draftMeta = new Map<string, GmailDraft>(); // keyed by message id, which changes on every edit
  let draftsCache: { at: number; value: Awaited<ReturnType<typeof loadDrafts>> } | null = null;

  async function gmailDrafts(): Promise<Array<GmailDraft & { older: number }>> {
    const list = await gws<{ drafts?: Array<{ id: string; message: { id: string; threadId: string } }> }>(
      ["gmail", "users", "drafts", "list", "--params", JSON.stringify({ userId: "me", maxResults: 60 })],
    );
    const items = list.drafts ?? [];
    // A draft sent or deleted anywhere is simply missing from the list.
    const live = new Set(items.map((d) => d.message.id));
    for (const k of draftMeta.keys()) if (!live.has(k)) draftMeta.delete(k);
    const queue = items.filter((d) => !draftMeta.has(d.message.id));
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        try {
          const g = await gws<{ message: { internalDate?: string; snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } } }>(
            ["gmail", "users", "drafts", "get", "--params", JSON.stringify({ userId: "me", id: d.id, format: "metadata", metadataHeaders: ["To", "Subject", "Received"] })],
          );
          const h = (n: string) => g.message.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
          draftMeta.set(d.message.id, {
            id: d.id, hexId: d.message.id, threadId: d.message.threadId,
            to: h("To").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || "(no recipient)",
            subject: h("Subject") || "(no subject)",
            snippet: (g.message.snippet ?? "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
            at: Number(g.message.internalDate ?? 0),
            // Drafts written through the API (agents) carry a gmailapi Received line.
            agent: /gmailapi\.google\.com/.test(h("Received")),
          });
        } catch (e) {
          bb.log.warn(`draft meta ${d.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    // Newest draft per email thread; older drafts in the same thread are
    // usually superseded versions, counted so you can clean them up.
    const byThread = new Map<string, GmailDraft[]>();
    for (const d of items) {
      const m = draftMeta.get(d.message.id);
      if (m) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
    }
    return [...byThread.values()]
      .map((group) => { group.sort((a, b) => b.at - a.at); return { ...group[0], older: group.length - 1 }; })
      .sort((a, b) => b.at - a.at);
  }

  // The address Gmail is signed in as, for links that name the account.
  let gmailAccount: string | null = null;
  async function gmailAddress() {
    if (!gmailAccount) {
      try { gmailAccount = (await gws<{ emailAddress?: string }>(["gmail", "users", "getProfile", "--params", JSON.stringify({ userId: "me" })])).emailAddress ?? null; }
      catch { /* links that need it are just left out */ }
    }
    return gmailAccount;
  }

  let slackAuth: { token: string; team: string | null; user: string | null } | null = null;
  async function slack(): Promise<typeof slackAuth> {
    if (slackAuth) return slackAuth;
    try {
      const { slackEnvFile } = await settings.get();
      if (!slackEnvFile) return null;
      const env = parseEnv(await readFile(expandHome(slackEnvFile), "utf8"));
      const token = env.SLACK_USER_TOKEN;
      if (!token) return null;
      const who = (await (await fetch("https://slack.com/api/auth.test", { headers: { authorization: `Bearer ${token}` } })).json()) as { user_id?: string; team_id?: string };
      slackAuth = { token, team: who.team_id ?? env.SLACK_TEAM_ID ?? null, user: who.user_id ?? null };
      return slackAuth;
    } catch { return null; }
  }

  const norm = (s: string) => s.toLowerCase().replace(/<[^>]*>/g, "").replace(/[^a-z0-9]+/g, " ").trim();

  // Did this message of yours send the draft? Its opening matches, or you edited
  // it first and kept a good share of its words.
  const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length >= 4));
  function sendsDraft(draft: string, message: string) {
    const opening = norm(draft).slice(0, 40);
    if (opening && norm(message).startsWith(opening)) return true;
    const dw = words(draft), mw = words(message);
    const shared = [...dw].filter((w) => mw.has(w)).length;
    return shared >= 2 && shared / dw.size >= 0.25;
  }

  // Slack drafts can't be listed or looked up with a user token (drafts.list and
  // drafts.info answer not_allowed_token_type), so your tools log each one they
  // file, and a draft deleted in Slack can't be seen from here. What Pocket can
  // know: a draft is gone once you send it (edited or not), a newer draft to the
  // same conversation replaces it (Slack keeps one per conversation), you can
  // remove one yourself, and after a few days it ages out.
  const SLACK_DRAFT_DAYS = 3;
  async function slackDrafts() {
    let text: string;
    const { slackDraftsLog } = await settings.get();
    if (!slackDraftsLog) return [];
    try { text = await readFile(expandHome(slackDraftsLog), "utf8"); } catch { return []; }
    const since = Date.now() / 1000 - SLACK_DRAFT_DAYS * 86400;
    const rows = text.trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
      .filter((r) => r.ts >= since && r.channel && r.text) as Array<{ ts: number; draft_id: string | null; channel: string; target: string; thread: string | null; text: string }>;
    const sentKeys = new Set((await bb.storage.kv.get<string[]>("slackSent")) ?? []);
    const auth = await slack();
    const out = [];
    const slots = new Set<string>();
    for (const r of rows.sort((a, b) => b.ts - a.ts)) {
      const slot = `${r.channel}:${r.thread ?? ""}`;
      if (slots.has(slot)) continue; // replaced by a newer draft here
      slots.add(slot);
      const key = r.draft_id ?? `${r.channel}:${r.ts}`;
      if (sentKeys.has(key)) continue;
      let sent = false;
      if (auth?.user) {
        try {
          const url = r.thread
            ? `https://slack.com/api/conversations.replies?channel=${r.channel}&ts=${r.thread}&oldest=${Math.floor(r.ts) - 1}&limit=100`
            : `https://slack.com/api/conversations.history?channel=${r.channel}&oldest=${Math.floor(r.ts) - 1}&limit=100`;
          const h = (await (await fetch(url, { headers: { authorization: `Bearer ${auth.token}` } })).json()) as { messages?: Array<{ user?: string; text?: string; ts?: string }> };
          // Replies always include the thread's first message, even from before the draft.
          sent = (h.messages ?? []).some((m) => m.user === auth.user && Number(m.ts) >= r.ts - 1 && sendsDraft(r.text, m.text ?? ""));
        } catch { /* unknown: keep showing it */ }
      }
      if (sent) { sentKeys.add(key); continue; }
      out.push({ key, target: r.target, channel: r.channel, thread: r.thread, text: r.text, at: Math.round(r.ts * 1000) });
    }
    await bb.storage.kv.set("slackSent", [...sentKeys].slice(-500));
    return out;
  }

  async function loadDrafts() {
    const { gmailDrafts: useGmail, slackDraftsLog } = await settings.get();
    const enabled = Boolean(useGmail || slackDraftsLog);
    const dismissed = new Set((await bb.storage.kv.get<string[]>("draftsDismissed")) ?? []);
    let gmail: Array<GmailDraft & { older: number }> = [];
    let gmailError: string | null = null;
    let account: string | null = null;
    if (useGmail) {
      await refreshGwsCfg();
      try { gmail = await gmailDrafts(); account = await gmailAddress(); } catch (e) { gmailError = e instanceof Error ? e.message : String(e); }
    }
    const slackItems = await slackDrafts();
    const auth = await slack();
    const style = await bb.storage.kv.get<string>("gmailLink");
    return {
      enabled,
      gmail: gmail.filter((d) => !dismissed.has(d.hexId)),
      slack: slackItems.filter((d) => !dismissed.has(d.key)),
      teamId: auth?.team ?? null,
      gmailError,
      gmailLink: (GMAIL_LINKS as readonly string[]).includes(style ?? "") ? style as typeof GMAIL_LINKS[number] : "app",
      account,
    };
  }

  // ---- quick replies -------------------------------------------------------
  // reasoning_effort only exists on OpenAI's reasoning models.
  const reasoning = (model: string, effort: string) => (/^(gpt-5|gpt-6|o\d)/.test(model) ? { reasoning_effort: effort } : {});
  const suggestSystem = (name: string) => [
    `You suggest one-tap quick replies for ${name}, who manages AI agents from their phone.`,
    "Given the agent's latest message (and their previous message for context), propose 0 to 4 replies they would most plausibly send next.",
    "Only propose replies grounded in the message: answering a question it asks, choosing among options it offers, approving or declining a proposed next step, or the single obvious follow-up.",
    "If the message is a plain report that needs no reply, return no pills.",
    "Each pill has `label` (2 to 5 words, what the button shows) and `text` (the exact message sent: first person, direct, at most 25 words).",
    "Never suggest that the agent send an email or Slack message, post anything, or delete anything; they send and delete things themselves. Suggesting a draft is fine.",
    "Never refer to anything the message doesn't contain (no invented drafts, files, or options).",
    "Skip open-ended options like 'Something else' or 'Other'; every pill must be a complete instruction on its own.",
    "Prefer decisive replies over questions. No pleasantries.",
  ].join(" ");

  // Fallback without the model: a closing yes/no question gets Yes / Not now.
  function heuristicPills(msg: string) {
    const last = msg.trim().split("\n").filter((l) => l.trim()).pop() ?? "";
    if (/\?\s*\**\s*$/.test(last) && /\b(should i|shall i|want me to|do you want|ok to|okay to|go ahead)\b/i.test(last)) {
      return [{ label: "Yes, go ahead", text: "Yes, go ahead." }, { label: "Not now", text: "Not now." }];
    }
    return [];
  }

  async function suggestFor(agentMsg: string, userMsg: string | null) {
    const key = await openaiKey();
    if (!key) return heuristicPills(agentMsg);
    const sModel = (await settings.get()).suggestModel || "gpt-5.6-luna";
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: sModel,
          // Luna at its default reasoning took ~4s and turned cautious (one
          // "I'll review" pill for a 7-question message); "none" answered in
          // ~1.6s with specific choices (tested 9/24).
          ...reasoning(sModel, "none"),
          messages: [
            { role: "system", content: suggestSystem(await who()) },
            { role: "user", content: `${userMsg ? `Their previous message:\n"""${userMsg.slice(-1500)}"""\n\n` : ""}The agent's latest message:\n"""${agentMsg.slice(-6000)}"""` },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "quick_replies", strict: true,
              schema: {
                type: "object", additionalProperties: false, required: ["pills"],
                properties: { pills: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["label", "text"], properties: { label: { type: "string" }, text: { type: "string" } } } } },
              },
            },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as { pills?: Array<{ label: string; text: string }> };
      return (parsed.pills ?? [])
        .filter((p) => p.label?.trim() && p.text?.trim())
        // Hard rule, not just a prompt: no pill may tell an agent to send,
        // post, or delete anything (you send and delete yourself).
        .filter((p) => !UNSAFE_PILL.test(`${p.label} ${p.text}`))
        .filter((p) => !/^(something else|other|none of these)\.?$/i.test(p.text.trim()))
        .slice(0, 4)
        .map((p) => ({ label: p.label.trim().slice(0, 40), text: p.text.trim().slice(0, 400) }));
    } catch (e) {
      bb.log.warn(`suggest failed: ${e instanceof Error ? e.message : e}`);
      return heuristicPills(agentMsg);
    }
  }

  // ---- stale threads: an opinionated recommendation -----------------------
  // The longer you leave an agent's message, the more useful a clear call is.
  // Once a thread is stale (seen and untouched 30 min, or unseen 2 h), Sol
  // picks one recommended reply with a reason, plus alternatives.
  const STALE_SEEN_MS = 30 * 60_000;
  const STALE_UNSEEN_MS = 2 * 3600_000;
  const recSystem = (name: string) => [
    `You are ${name === "the user" ? "the user's" : `${name}'s`} chief of staff. They manage AI agents from their phone and have left this agent's latest message unanswered for a while.`,
    "First, `stake`: one line (at most 18 words) saying what's at stake, meaning the decision they're being asked to make and why it matters, so they have the minimum context before your pick.",
    "Then be opinionated: choose the single reply you would send in their place, and say why in at most 15 words, grounded in the message.",
    "Also give up to 3 genuinely different alternatives.",
    "Each reply has `label` (2 to 5 words) and `text` (the exact message: first person, direct, at most 25 words).",
    "If the message truly needs no reply (a plain report), return no pills and recommended -1.",
    "Never tell the agent to send an email or Slack message, post, forward, or delete anything; they do those themselves. Asking for a draft is fine.",
    "Never refer to anything the message doesn't contain. No pleasantries, no open-ended options like 'Something else'.",
  ].join(" ");

  function cleanPills(pills: Array<{ label?: string; text?: string }>) {
    return pills
      .filter((p) => p.label?.trim() && p.text?.trim())
      .map((p) => ({ label: p.label!.trim().slice(0, 40), text: p.text!.trim().slice(0, 400) }));
  }

  type Rec = { forAt: number; attn: number; pills: Array<{ label: string; text: string }>; recommended: number; reason: string; stake: string };

  async function recommendFor(agentMsg: string, userMsg: string | null, waitedMin: number): Promise<Omit<Rec, "forAt" | "attn"> | null> {
    const key = await openaiKey();
    if (!key) return null;
    const rModel = (await settings.get()).recommendModel || "gpt-6-sol";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: rModel,
        ...reasoning(rModel, "low"),
        messages: [
          { role: "system", content: recSystem(await who()) },
          { role: "user", content: `It has been waiting about ${waitedMin} minutes.\n\n${userMsg ? `Their previous message:\n"""${userMsg.slice(-2000)}"""\n\n` : ""}The agent's latest message:\n"""${agentMsg.slice(-8000)}"""` },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "recommendation", strict: true,
            schema: {
              type: "object", additionalProperties: false, required: ["stake", "pills", "recommended", "reason"],
              properties: {
                stake: { type: "string" },
                pills: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["label", "text"], properties: { label: { type: "string" }, text: { type: "string" } } } },
                recommended: { type: "integer" },
                reason: { type: "string" },
              },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as { stake?: string; pills?: Array<{ label: string; text: string }>; recommended?: number; reason?: string };
    const stake = (parsed.stake ?? "").trim().slice(0, 160);
    const all = cleanPills(parsed.pills ?? []);
    const pick = typeof parsed.recommended === "number" ? all[parsed.recommended] : undefined;
    // The send/post/delete filter applies to Sol too; a filtered pick means no pick.
    const pills = all.filter(safePill);
    if (!pick || !safePill(pick)) return pills.length ? { pills, recommended: -1, reason: "", stake } : null;
    // The recommended reply always goes first.
    const ordered = [pick, ...pills.filter((p) => p !== pick)].slice(0, 4);
    return { pills: ordered, recommended: 0, reason: (parsed.reason ?? "").trim().slice(0, 140), stake };
  }

  // When did you first see the agent's latest message? Opening it in Pocket
  // (recorded by the thread RPC) or reading it in bb (lastReadAt).
  async function seenAt(t: Dto, forAt: number): Promise<number | null> {
    const s = await bb.storage.kv.get<{ forAt: number; at: number }>(`seen:${t.id}`);
    if (s && s.forAt === forAt) return s.at;
    if (t.lastReadAt && t.lastReadAt >= forAt) return t.lastReadAt;
    return null;
  }

  async function lastTurn(threadId: string) {
    const tl = await bb.sdk.threads.timeline({ threadId, segmentLimit: "6" });
    const rows = (tl.rows as Array<Record<string, unknown>>).filter((r) => r.kind === "conversation" && typeof r.text === "string" && (r.text as string).trim());
    const last = rows[rows.length - 1];
    const prevUser = [...rows].reverse().find((r) => r.role === "user");
    return last?.role === "assistant"
      ? { forAt: typeof last.createdAt === "number" ? last.createdAt : 0, agent: last.text as string, user: prevUser ? (prevUser.text as string) : null }
      : null;
  }

  let recRunning = false;
  async function recommendSweep() {
    if (recRunning) return;
    if (!(await settings.get()).recommendations || !(await openaiKey())) return;
    recRunning = true;
    try {
      const list = (await bb.sdk.threads.list({ archived: false, limit: 300 })) as Dto[];
      const since = Date.now() - 3 * DAY;
      const candidates = list.filter((t) => (!t.parentThreadId || t.pinnedAt) && !t.hasPendingInteraction && !isWorking(statusOf(t)) && lastActive(t) >= since);
      let made = 0;
      for (const t of candidates) {
        if (made >= 6) break; // bounded per sweep; the rest wait five minutes
        const attn = t.latestAttentionAt ?? 0;
        if (await isDismissed(t)) continue;
        const have = await bb.storage.kv.get<Rec | { attn: number; none: true }>(`rec:${t.id}`);
        if (have && have.attn === attn) continue; // already decided for this message
        const turn = await lastTurn(t.id);
        if (!turn) { await bb.storage.kv.set(`rec:${t.id}`, { attn, none: true }); continue; }
        const seen = await seenAt(t, turn.forAt);
        const age = Date.now() - (seen ?? turn.forAt);
        if (age < (seen ? STALE_SEEN_MS : STALE_UNSEEN_MS)) continue; // not stale yet; look again next sweep
        try {
          const r = await recommendFor(turn.agent, turn.user, Math.round((Date.now() - turn.forAt) / 60_000));
          made++;
          await bb.storage.kv.set(`rec:${t.id}`, r ? { forAt: turn.forAt, attn, ...r } : { attn, none: true });
          if (r && r.recommended >= 0) {
            const log = (await bb.storage.kv.get<Array<Record<string, any>>>("recLog")) ?? [];
            const entry = { threadId: t.id, title: titleOf(t), forAt: turn.forAt, label: r.pills[0].label, reason: r.reason, stake: r.stake };
            const same = log.find((x) => x.threadId === t.id && x.forAt === turn.forAt);
            if (same) Object.assign(same, entry); else log.push({ at: Date.now(), ...entry });
            await bb.storage.kv.set("recLog", log.slice(-1000));
          }
          bb.log.info(`rec ${t.id}: ${r && r.recommended >= 0 ? `"${r.pills[0].label}" (${r.reason.slice(0, 60)})` : "none"}`);
        } catch (e) {
          bb.log.warn(`rec ${t.id} failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    } finally {
      recRunning = false;
    }
  }

  async function isDismissed(t: Dto): Promise<boolean> {
    const d = await bb.storage.kv.get<number>(`dismissed:${t.id}`);
    return d !== null && d !== undefined && d === (t.latestAttentionAt ?? 0);
  }

  async function currentRec(t: Dto): Promise<Rec | null> {
    const r = await bb.storage.kv.get<Rec & { none?: true }>(`rec:${t.id}`);
    if (!r || r.none || r.attn !== (t.latestAttentionAt ?? 0) || isWorking(statusOf(t)) || t.hasPendingInteraction) return null;
    return r;
  }

  // One-time: recommendations made before recLog existed (9/24) join the log,
  // so the one-week readout starts from the first ones you saw.
  void (async () => {
    if ((await bb.storage.kv.get("recLog")) !== undefined) return;
    const seeded: Array<Record<string, unknown>> = [];
    for (const key of await bb.storage.kv.list("rec:")) {
      const r = await bb.storage.kv.get<Rec & { none?: true }>(key);
      if (r && !r.none && r.recommended >= 0 && r.pills?.[0]) seeded.push({ at: Date.now(), threadId: key.slice(4), forAt: r.forAt, label: r.pills[0].label, reason: r.reason, seeded: true });
    }
    await bb.storage.kv.set("recLog", seeded);
    bb.log.info(`recLog seeded with ${seeded.length} earlier recommendations`);
  })().catch(() => undefined);

  // Recommendations from before the stake line (9/24) are dropped so the next
  // sweeps regenerate them with one.
  void (async () => {
    for (const key of await bb.storage.kv.list("rec:")) {
      const r = await bb.storage.kv.get<Rec & { none?: true }>(key);
      if (r && !r.none && r.stake === undefined) await bb.storage.kv.delete(key);
    }
  })().catch(() => undefined);

  bb.background.service("recommend", {
    async start(signal) {
      const sleep = (ms: number) => new Promise<void>((resolve) => {
        const done = () => { signal.removeEventListener("abort", onAbort); resolve(); };
        const onAbort = () => { clearTimeout(timer); done(); };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      await sleep(30_000);
      while (!signal.aborted) {
        try { await recommendSweep(); } catch (e) { bb.log.warn(`rec sweep: ${e instanceof Error ? e.message : e}`); }
        await sleep(5 * 60_000);
      }
    },
  });

  // Quick-reply pills for the agent's message at `forAt`, cached per thread so
  // the page and the notifier share one model call.
  async function cachedPills(threadId: string, forAt: number, agent: string, user: string | null) {
    const cached = await bb.storage.kv.get<{ forAt: number; pills: Choice[] }>(`sug4:${threadId}`);
    if (cached && cached.forAt === forAt) return cached;
    const value = { forAt, pills: await suggestFor(agent, user) };
    await bb.storage.kv.set(`sug4:${threadId}`, value);
    return value;
  }

  // ---- notifications ------------------------------------------------------
  // The Pocket iOS app registers a device token; this service watches for
  // what would put a thread in Needs you (a pending approval or question, an
  // agent reply you haven't read, a stale-thread recommendation) and pushes
  // one notification per agent message through APNs. Answers come back
  // through the ordinary RPCs (send, approve, answer, setRead, dismiss).
  type Device = { token: string; env: "sandbox" | "production"; bundleId: string; addedAt: number; lastSeen: number };
  const devices = async () => (await bb.storage.kv.get<Device[]>("devices")) ?? [];
  const NOTIFY_POLL_MS = 20_000;
  const BACKLOG_MS = 30 * 60_000; // no backlog blast: older messages are passed over when notifications start
  const notifyLimit = new RateLimit(6, 60_000);

  let jwtCache: { ident: string; at: number; token: string } | null = null;
  async function providerToken(keyFile: string, keyId: string, teamId: string): Promise<string> {
    const ident = `${keyFile}|${keyId}|${teamId}`;
    if (jwtCache && jwtCache.ident === ident && Date.now() - jwtCache.at < JWT_TTL_MS) return jwtCache.token;
    const pem = await readFile(expandHome(keyFile), "utf8");
    const token = apnsJwt(pem, keyId, teamId, Math.floor(Date.now() / 1000));
    jwtCache = { ident, at: Date.now(), token };
    return token;
  }

  const h2sessions = new Map<string, ClientHttp2Session>();
  function h2session(origin: string): ClientHttp2Session {
    const open = h2sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const s = h2connect(origin);
    const drop = () => { if (h2sessions.get(origin) === s) h2sessions.delete(origin); };
    s.on("error", (e) => { bb.log.warn(`apns connection: ${e.message}`); drop(); });
    s.on("close", drop);
    s.on("goaway", drop);
    s.unref();
    h2sessions.set(origin, s);
    return s;
  }
  const closeSessions = () => { for (const s of h2sessions.values()) s.close(); h2sessions.clear(); };

  function apnsPost(origin: string, deviceToken: string, headers: Record<string, string>, body: string): Promise<{ status: number; reason: string | null }> {
    return new Promise((resolve, reject) => {
      const req = h2session(origin).request({ ":method": "POST", ":path": `/3/device/${deviceToken}`, "content-type": "application/json", ...headers });
      let status = 0;
      let data = "";
      req.setEncoding("utf8");
      req.setTimeout(15_000, () => req.close(h2.NGHTTP2_CANCEL));
      req.on("response", (h) => { status = Number(h[":status"]); });
      req.on("data", (c: string) => { data += c; });
      req.on("end", () => {
        let reason: string | null = null;
        try { reason = (JSON.parse(data) as { reason?: string }).reason ?? null; } catch { /* 200 has no body */ }
        resolve({ status, reason: status ? reason : reason ?? "timeout" });
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  const loadPrefs = async (): Promise<NotifyPrefs> => normalizePrefs(await bb.storage.kv.get("notifyPrefs"));
  async function pushState() {
    const cfg = await settings.get();
    const keyReady = Boolean(cfg.apnsKeyFile && cfg.apnsKeyId && cfg.apnsTeamId);
    return { cfg, keyReady, dryRun: cfg.notificationsDryRun !== false || !keyReady, want: (cfg.apnsBundleId || "").trim() };
  }

  /** Send one notice to every registered device, or log it in a dry run. */
  async function deliver(n: Notice, opts: { passive?: boolean } = {}) {
    const payload = buildPayload(n, opts);
    return deliverPayload(payload, n.threadId, `${n.threadId} ${n.kind}${opts.passive ? " (quiet hours)" : ""}`, JSON.stringify(redacted(payload)));
  }

  async function deliverPayload(payload: object, collapseId: string, label: string, logged: string): Promise<{ dryRun: boolean; results: Array<{ device: string; env: string; status: number; reason: string | null }> }> {
    const { cfg, keyReady, dryRun, want } = await pushState();
    const all = await devices();
    const targets = want ? all.filter((d) => d.bundleId === want) : all;
    if (dryRun) {
      bb.log.info(`notify (dry run${keyReady ? "" : ", no APNs key"}) ${label} → ${targets.length} device(s): ${logged}`);
      return { dryRun: true, results: targets.map((d) => ({ device: `…${d.token.slice(-6)}`, env: d.env, status: 0, reason: "dry run" })) };
    }
    if (!targets.length) bb.log.info(`notify ${label}: no registered devices`);
    const body = JSON.stringify(payload);
    const results = [];
    const dead = new Set<string>();
    for (const d of targets) {
      let r: { status: number; reason: string | null };
      try {
        const send = async () => apnsPost(APNS_HOST[d.env], d.token, apnsHeaders(d.bundleId, collapseId, await providerToken(cfg.apnsKeyFile, cfg.apnsKeyId, cfg.apnsTeamId)), body);
        r = await send();
        if (r.status === 403 && r.reason === "ExpiredProviderToken") { jwtCache = null; r = await send(); }
      } catch (e) {
        r = { status: 0, reason: e instanceof Error ? e.message.slice(0, 120) : "error" };
      }
      bb.log.info(`notify ${label} → …${d.token.slice(-6)} (${d.env}): ${r.status}${r.reason ? ` ${r.reason}` : ""}`);
      if (isDeadToken(r.status, r.reason ?? undefined)) dead.add(d.token);
      results.push({ device: `…${d.token.slice(-6)}`, env: d.env, status: r.status, reason: r.reason });
    }
    if (dead.size) {
      // Re-read so a registration that landed meanwhile isn't lost.
      await bb.storage.kv.set("devices", (await devices()).filter((d) => !dead.has(d.token)));
      bb.log.info(`dropped ${dead.size} unregistered device(s)`);
    }
    return { dryRun: false, results };
  }

  // Home's rows: top-level threads, plus children that are pinned or blocked
  // on a question. Anything else is hidden in Pocket and never notifies.
  const onHome = (t: Dto) => !t.parentThreadId || t.hasPendingInteraction || t.pinnedAt;

  let enabledSince: number | null = null;
  async function notifyPoll() {
    if (!(await settings.get()).notifications) { enabledSince = null; return; }
    enabledSince ??= Date.now();
    const cutoff = enabledSince - BACKLOG_MS;
    const list = ((await bb.sdk.threads.list({ archived: false, limit: 300 })) as Dto[]).filter(onHome);
    const found: Array<{ n: Notice; threadId: string }> = [];
    const nextState = new Map<string, NotifState>();
    for (const t of list) {
      if (await isDismissed(t)) continue;
      const key = `notif:${t.id}`;
      const st = (await bb.storage.kv.get<NotifState>(key)) ?? emptyState();
      const next: NotifState = { ...st, ints: [...st.ints] };
      const attn = t.latestAttentionAt ?? 0;
      const fresh = st.attn !== attn || st.upd !== t.updatedAt;
      const title = titleOf(t);
      try {
        if (fresh && t.hasPendingInteraction) {
          // 1. A permission request or question is waiting on you.
          const pending = (await bb.sdk.threads.interactions.list({ threadId: t.id })) as unknown as Array<{ id: string; status: string; createdAt: number; payload: Record<string, any> }>;
          for (const i of pending.filter((x) => x.status === "pending" && !st.ints.includes(x.id))) {
            next.ints.push(i.id);
            if (verdict({ forAt: i.createdAt, handledForAt: 0, cutoff, lastReadAt: t.lastReadAt, needsUnread: true }) !== "notify") continue;
            const n = interactionNotice(t.id, title, i);
            if (n) found.push({ n, threadId: t.id });
          }
          next.ints = next.ints.slice(-50);
        } else if (fresh && isUnread(t) && !isWorking(statusOf(t))) {
          // 2. The agent finished and its reply is waiting, unread.
          const turn = await lastTurn(t.id);
          if (turn) {
            const v = verdict({ forAt: turn.forAt, handledForAt: st.forAt, cutoff, lastReadAt: t.lastReadAt, needsUnread: true });
            // Read already: not handled, so a later recommendation can still notify.
            if (v === "notify" || v === "old") next.forAt = turn.forAt;
            if (v === "notify") {
              const rec = await currentRec(t).catch(() => null);
              const pills = rec?.forAt === turn.forAt ? null : await cachedPills(t.id, turn.forAt, turn.agent, turn.user).catch(() => null);
              const c = replyChoices(turn.forAt, rec, pills);
              found.push({ threadId: t.id, n: { threadId: t.id, kind: "reply", title, body: plainText(turn.agent) || "Replied", forAt: turn.forAt, ...c } });
            }
          }
        }
        // 3. A stale-thread recommendation for a message not yet notified. It
        // shows in Needs you whether or not you've read the thread, so it
        // notifies either way.
        const rec = await currentRec(t).catch(() => null);
        if (rec && rec.recommended >= 0 && verdict({ forAt: rec.forAt, handledForAt: next.forAt, cutoff, lastReadAt: t.lastReadAt, needsUnread: false }) === "notify") {
          next.forAt = rec.forAt;
          const turn = rec.stake ? null : await lastTurn(t.id).catch(() => null);
          const body = rec.stake || (turn?.forAt === rec.forAt ? plainText(turn.agent) : "") || rec.reason || "Has a recommended reply";
          found.push({ threadId: t.id, n: { threadId: t.id, kind: "reply", title, body: plainText(body), forAt: rec.forAt, ...replyChoices(rec.forAt, rec, null) } });
        }
      } catch (e) {
        bb.log.warn(`notify check ${t.id}: ${e instanceof Error ? e.message : e}`);
        continue; // looked at again next poll
      }
      next.attn = attn;
      next.upd = t.updatedAt;
      if (JSON.stringify(next) !== JSON.stringify(st)) nextState.set(t.id, next);
    }
    // Newest first under the rate limit; a thread whose notice has to wait
    // keeps its old state, so the next poll finds it again.
    found.sort((a, b) => b.n.forAt - a.n.forAt);
    // Your settings: a kind you turned off is marked handled and never sent;
    // in quiet hours it's sent silently (Notification Center, no sound).
    const prefs = await loadPrefs();
    const quiet = inQuietHours(prefs);
    for (const f of found) {
      if (!prefs.kinds[f.n.kind]) { bb.log.info(`notify ${f.threadId} ${f.n.kind}: off in your settings, not sent`); continue; }
      if (!notifyLimit.take(Date.now())) { nextState.delete(f.threadId); continue; }
      try { await deliver(f.n, { passive: quiet }); } catch (e) { bb.log.warn(`notify ${f.threadId} ${f.n.kind}: ${e instanceof Error ? e.message : e}`); }
    }
    for (const [id, st] of nextState) await bb.storage.kv.set(`notif:${id}`, st);
  }

  bb.background.service("notify", {
    async start(signal) {
      const sleep = (ms: number) => new Promise<void>((resolve) => {
        const done = () => { signal.removeEventListener("abort", onAbort); resolve(); };
        const onAbort = () => { clearTimeout(timer); done(); };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      enabledSince = null; // a restart doesn't replay what arrived while it was down
      await sleep(5_000);
      while (!signal.aborted) {
        try { await notifyPoll(); } catch (e) { bb.log.warn(`notify poll: ${e instanceof Error ? e.message : e}`); }
        await sleep(NOTIFY_POLL_MS);
      }
      closeSessions();
    },
  });

  // ---- machines and models ------------------------------------------------
  let hostCache: { at: number; list: Array<{ id: string; name: string; online: boolean }> } | null = null;
  async function hosts() {
    if (hostCache && Date.now() - hostCache.at < 30_000) return hostCache.list;
    const raw = (await bb.sdk.hosts.list()) as unknown as Array<{ id: string; name?: string; status?: string; lastSeenAt?: number }>;
    // "connected" alone can lie: a sleeping Mac stayed "connected" with a
    // 15-minute-old check-in on 9/25, and a thread sent to it hung in
    // "starting". Online = connected AND seen in the last 5 minutes.
    const fresh = (h: { lastSeenAt?: number }) => !h.lastSeenAt || Date.now() - h.lastSeenAt < 5 * 60_000;
    const list = (Array.isArray(raw) ? raw : []).map((h) => ({ id: h.id, name: h.name || h.id, online: h.status === "connected" && fresh(h) }));
    hostCache = { at: Date.now(), list };
    return list;
  }

  type CatalogProvider = { id: string; name: string; models: Array<{ id: string; name: string; isDefault: boolean; efforts: string[]; defaultEffort?: string | null }> };
  let catalogCache: { at: number; providers: CatalogProvider[] } | null = null;
  async function catalog(): Promise<CatalogProvider[]> {
    if (catalogCache && Date.now() - catalogCache.at < 10 * 60_000) return catalogCache.providers;
    const plist = (await bb.sdk.providers.list()) as unknown as Array<{ id: string; name?: string; displayName?: string; available?: boolean }>;
    const providers = await Promise.all(plist.filter((p) => p.available !== false).map(async (p) => {
      let models: CatalogProvider["models"] = [];
      try {
        const raw = (await bb.sdk.providers.models({ providerId: p.id })) as unknown;
        // The response carries `models` next to a `providers` list; take models.
        const arr = (Array.isArray(raw) ? raw : ((raw as { models?: unknown[] }).models ?? [])) as Array<Record<string, any>>;
        models = arr.filter((m) => m && (m.id || m.model)).map((m) => ({
          id: String(m.model ?? m.id),
          name: String(m.displayName ?? m.name ?? m.id).trim(),
          isDefault: Boolean(m.isDefault ?? m.default),
          efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => String(e.reasoningEffort ?? e)).filter(Boolean),
          defaultEffort: m.defaultReasoningEffort ?? null,
        }));
      } catch { /* provider not usable right now */ }
      return { id: p.id, name: p.displayName ?? p.name ?? p.id, models };
    }));
    catalogCache = { at: Date.now(), providers: providers.filter((p) => p.models.length) };
    return catalogCache.providers;
  }
  const modelName = async (providerId: string, model: string | null) =>
    model ? (await catalog().catch(() => [])).find((p) => p.id === providerId)?.models.find((m) => m.id === model)?.name ?? model : null;

  async function chooseManager(list: Dto[], detected: Set<string>): Promise<{ id: string | null; chosen: boolean }> {
    const pick = await bb.storage.kv.get<string>("managerOverride");
    if (pick && list.some((t) => t.id === pick)) return { id: pick, chosen: true };
    const auto = list.filter((t) => detected.has(t.id)).sort((a, b) => lastActive(b) - lastActive(a))[0];
    return { id: auto?.id ?? null, chosen: false };
  }

  let talkCache: { at: number; ok: boolean } | null = null;
  async function talkAvailable(): Promise<boolean> {
    if (talkCache && Date.now() - talkCache.at < 60_000) return talkCache.ok;
    let ok = false;
    try {
      const raw = (await bb.sdk.plugins.list()) as unknown;
      const list = (Array.isArray(raw) ? raw : Object.values(raw as object).find(Array.isArray) ?? []) as Array<{ id?: string; status?: string; enabled?: boolean }>;
      ok = list.some((p) => p?.id === "talk-to-bb" && p.enabled !== false && (p.status ?? "running") === "running");
    } catch { ok = false; }
    talkCache = { at: Date.now(), ok };
    return ok;
  }

  // ---- File links ---------------------------------------------------------
  // Like bb web: a relative link is a file in the thread's environment, an
  // absolute one is on the thread's machine, thread-storage:… is in the
  // thread's storage folder.
  const envCache = new Map<string, { at: number; path: string | null; hostId: string | null }>();
  async function threadEnv(threadId: string) {
    const hit = envCache.get(threadId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
    const t = (await bb.sdk.threads.get({ threadId })) as unknown as Dto & { environmentId?: string | null };
    let path = t.environmentPath ?? null, hostId = t.environmentHostId ?? null;
    if (!path && t.environmentId) {
      try {
        const env = (await bb.sdk.environments.get({ environmentId: t.environmentId })) as unknown as { path?: string; hostId?: string };
        path = env.path ?? null; hostId = env.hostId ?? hostId;
      } catch { /* relative links stay unresolved */ }
    }
    const out = { at: Date.now(), path, hostId };
    envCache.set(threadId, out);
    return out;
  }

  type FileLink = { hostId: string | null; path: string; kind: string; name: string; local: boolean };
  // The access you picked for a thread in Pocket, sent with each message to it.
  async function accessFor(threadId: string): Promise<"auto" | "full" | null> {
    const v = await bb.storage.kv.get<string>(`access:${threadId}`);
    return v === "auto" || v === "full" ? v : null;
  }

  // ---- attachments you send -------------------------------------------------
  async function attach(projectId: string, files: Array<z.infer<typeof upFile>>) {
    const decoded = files.map((f) => ({ ...f, bytes: Buffer.from(f.data, "base64") }));
    const total = decoded.reduce((n, f) => n + f.bytes.length, 0);
    if (total > MAX_UPLOAD_BYTES) throw new Error(`Attachments are ${Math.round(total / 1048576)} MB; the limit is 30 MB.`);
    const out = [];
    for (const f of decoded) {
      const a = await bb.sdk.projects.attachments.upload({
        projectId,
        clientFile: new Uint8Array(f.bytes),
        filename: basename(f.name).replace(/[\u0000-\u001f]/g, "") || "file",
        ...(f.mime ? { mimeType: f.mime } : {}),
      });
      out.push(a.type === "localImage"
        ? { type: "localImage" as const, path: a.path }
        : { type: "localFile" as const, path: a.path, name: a.name, ...(a.mimeType ? { mimeType: a.mimeType } : {}), sizeBytes: a.sizeBytes });
    }
    bb.log.info(`attached ${out.length} file(s), ${Math.round(total / 1024)} KB, to ${projectId}`);
    return out;
  }

  function rowFiles(row: Record<string, unknown>) {
    const a = row.attachments as { localImagePaths?: string[]; localFilePaths?: string[] } | null | undefined;
    if (!a) return [];
    // bb stores uploads as name-<ms>-<random>.ext; show the name that was picked.
    const shown = (path: string) => basename(path).replace(/-\d{13}-[a-z0-9]{6}(?=\.[^.]+$|$)/, "");
    return [
      ...(a.localImagePaths ?? []).map((path) => ({ path, name: shown(path), image: true })),
      ...(a.localFilePaths ?? []).map((path) => ({ path, name: shown(path), image: false })),
    ];
  }

  async function resolveLink(threadId: string, href: string): Promise<FileLink | null> {
    let p = href.trim();
    if (!p || /^(https?|mailto|tel|data|javascript):/i.test(p) || p.startsWith("#")) return null;
    p = p.replace(/^file:\/\//, "").replace(/[?#].*$/, "").replace(/:\d+(:\d+)?$/, "");
    try { p = decodeURIComponent(p); } catch { /* keep as-is */ }
    const { primaryHostId } = (await bb.sdk.system.config()) as { primaryHostId?: string };
    let hostId: string | null;
    if (p.startsWith("thread-storage:")) {
      const loc = (await bb.sdk.threads.storageLocation({ threadId })) as { hostId: string; storageRootPath: string };
      hostId = loc.hostId;
      p = join(loc.storageRootPath, p.slice("thread-storage:".length).replace(/^\/+/, ""));
    } else {
      const env = await threadEnv(threadId);
      hostId = env.hostId;
      if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
      else if (!isAbsolute(p)) {
        if (!env.path || /^[a-z][a-z0-9+.-]*:/i.test(p)) return null;
        p = join(env.path, p);
      }
    }
    p = normalize(p);
    if (p.endsWith("/")) return null;
    const local = !hostId || hostId === primaryHostId;
    return { hostId: local ? primaryHostId ?? null : hostId, path: p, kind: FILE_KINDS[extname(p).toLowerCase()] ?? "file", name: basename(p), local };
  }

  async function fileExists(f: FileLink): Promise<boolean | null> {
    if (!f.local) return null; // another machine (a sleeping Mac would hang the check)
    try { return (await stat(f.path)).isFile(); } catch { return false; }
  }

  async function readLinked(f: FileLink): Promise<Buffer> {
    if (f.local) return readFile(f.path);
    const r = (await bb.sdk.files.read({ hostId: f.hostId ?? undefined, path: f.path })) as { content: string; contentEncoding: "base64" | "utf8" };
    return Buffer.from(r.content, r.contentEncoding);
  }

  // One preview per folder, reused until shortly before it expires.
  const previewCache = new Map<string, { until: number; baseUrl: string }>();
  async function previewUrl(f: FileLink): Promise<string> {
    const key = `${f.hostId}:${dirname(f.path)}`;
    let hit = previewCache.get(key);
    if (!hit || hit.until < Date.now()) {
      const preview = await bb.sdk.files.createPreview({ hostId: f.hostId ?? undefined, rootPath: dirname(f.path), ttlMs: 30 * 60_000 });
      hit = { until: Date.now() + 25 * 60_000, baseUrl: previewPath(preview.baseUrl) };
      previewCache.set(key, hit);
    }
    return `${hit.baseUrl}/${encodeURIComponent(basename(f.path))}`;
  }

  // ---- RPC ----------------------------------------------------------------
  bb.rpc.register(rpcContract, {
    async home() {
      const [names, list, managers] = await Promise.all([
        projectNames(),
        bb.sdk.threads.list({ archived: false, limit: 300 }),
        managerIds().catch(() => new Set<string>()),
      ]);
      // Top-level threads, plus any child that is pinned or blocked on a
      // question: those are the only children a person acts on directly.
      const shown = (list as Dto[]).filter((t) => !t.parentThreadId || t.hasPendingInteraction || t.pinnedAt);
      const rows = shown.map((t) => ({
        id: t.id,
        projectId: t.projectId,
        projectName: names.get(t.projectId) ?? "",
        title: titleOf(t),
        status: statusOf(t),
        unread: isUnread(t),
        pending: Boolean(t.hasPendingInteraction),
        pinned: Boolean(t.pinnedAt),
        manager: managers.has(t.id),
        child: Boolean(t.parentThreadId),
        updatedAt: lastActive(t),
        preview: null as string | null,
        rec: null as { label: string; text: string; reason: string; stake: string } | null,
        dismissed: false,
        hostId: t.environmentHostId ?? null,
        pinSortKey: t.pinSortKey ?? "",
      }));
      await Promise.all(shown.map(async (t, i) => {
        if (await isDismissed(t)) { rows[i].dismissed = true; return; }
        const r = await currentRec(t).catch(() => null);
        if (r && r.recommended >= 0 && r.pills[0]) rows[i].rec = { ...r.pills[0], reason: r.reason, stake: r.stake ?? "" };
      }));
      rows.sort((a, b) => {
        if (a.pinned && b.pinned) return a.pinSortKey.localeCompare(b.pinSortKey) || b.updatedAt - a.updatedAt;
        return b.updatedAt - a.updatedAt;
      });

      // A one-line preview for the rows you'd act on.
      const needy = rows.filter((r) => r.pending || r.unread || r.pinned || r.manager).slice(0, PREVIEW_FETCH_MAX);
      await Promise.all(
        needy.map(async (r) => {
          try {
            const { output } = await bb.sdk.threads.output({ threadId: r.id });
            r.preview = output ? previewOf(output) : null;
          } catch {
            r.preview = null;
          }
        }),
      );

      // Voice goes to your chosen manager, else the detected one with the most recent history.
      const mgr = await chooseManager(list as Dto[], managers);
      const managerId = mgr.id;

      const recentProjects = new Map<string, string>();
      for (const r of rows) if (r.projectName && !recentProjects.has(r.projectId)) recentProjects.set(r.projectId, r.projectName);
      for (const [id, name] of names) if (!recentProjects.has(id)) recentProjects.set(id, name);

      let newArtifacts = 0;
      if (artifactCache) {
        const seen = await seenSet();
        newArtifacts = artifactCache.items.filter((a) => isNew(a, seen)).length;
      }
      // Keep the artifact list warm so the badge and the pane are current.
      if (!artifactCache || Date.now() - artifactCache.at > 45_000) void artifacts().catch(() => undefined);

      return {
        threads: rows.map(({ pinSortKey: _p, ...r }) => r),
        projects: [...recentProjects].map(([id, name]) => ({ id, name })),
        managerId,
        managerChosen: mgr.chosen,
        newArtifacts,
        walk: await talkAvailable(),
        machines: await hosts().catch(() => []),
      };
    },

    async thread({ threadId }) {
      const [t, timeline, pending, names, waiting] = await Promise.all([
        bb.sdk.threads.get({ threadId }),
        bb.sdk.threads.timeline({ threadId, segmentLimit: "30" }),
        bb.sdk.threads.interactions.list({ threadId }),
        projectNames(),
        queuedMine(threadId),
      ]);

      // Your messages, and the last thing the agent said in each turn. Tool
      // calls, reasoning, and interim narration are left to full bb.
      const messages: z.infer<typeof message>[] = [];
      let lastTurn: string | null = null;
      for (const row of timeline.rows as Array<Record<string, unknown>>) {
        if (row.kind !== "conversation") continue;
        const role = row.role;
        const text = typeof row.text === "string" ? row.text.trim() : "";
        const files = role === "user" ? rowFiles(row) : [];
        if ((role !== "user" && role !== "assistant") || (!text && !files.length)) continue;
        const at = typeof row.createdAt === "number" ? row.createdAt : 0;
        const turn = typeof row.turnId === "string" ? row.turnId : null;
        const prev = messages[messages.length - 1];
        if (role === "assistant" && prev?.role === "assistant" && turn !== null && turn === lastTurn) {
          messages[messages.length - 1] = { role, text, at };
        } else {
          messages.push({ role, text, at, ...(files.length ? { files } : {}) });
        }
        lastTurn = turn;
      }

      const interactions = pending
        .filter((i) => i.status === "pending")
        .map((i): z.infer<typeof interaction> => {
          const p = i.payload as Record<string, any>;
          if (p.kind === "approval") {
            const { summary, detail } = describeApproval(p);
            return {
              kind: "approval",
              id: i.id,
              summary,
              detail,
              canAllowForSession: Array.isArray(p.availableDecisions) && p.availableDecisions.includes("allow_for_session"),
            };
          }
          if (p.kind === "user_question" && Array.isArray(p.questions)) {
            return {
              kind: "question",
              id: i.id,
              questions: p.questions.map((q: any) => ({
                id: String(q.id),
                prompt: String(q.prompt ?? ""),
                multiSelect: Boolean(q.multiSelect),
                allowFreeText: Boolean(q.allowFreeText),
                options: (q.options ?? []).map((o: any) => ({
                  label: String(o.label),
                  value: String(o.value),
                  description: o.description ? String(o.description) : null,
                })),
              })),
            };
          }
          return { kind: "other", id: i.id };
        });

      const dto = t as unknown as Dto;
      // First time you see the agent's latest message starts the "seen" clock.
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === "assistant") {
        const s = await bb.storage.kv.get<{ forAt: number }>(`seen:${threadId}`);
        if (!s || s.forAt !== lastMsg.at) await bb.storage.kv.set(`seen:${threadId}`, { forAt: lastMsg.at, at: Date.now() });
      }
      const rec = await currentRec(dto).catch(() => null);
      // Where it runs and what runs it (the thread's model, else the defaults it inherits).
      let machine: { id: string; name: string; online: boolean } | null = null;
      const envId = (t as unknown as { environmentId?: string | null }).environmentId;
      if (envId) {
        try {
          const env = (await bb.sdk.environments.get({ environmentId: envId })) as unknown as { hostId?: string };
          machine = (await hosts()).find((h) => h.id === env.hostId) ?? null;
        } catch { /* environment gone */ }
      }
      const providerId = (t as unknown as { providerId?: string }).providerId ?? "";
      let eff: { model?: string | null; reasoningLevel?: string | null; permissionMode?: string | null } = {};
      try { eff = (await bb.sdk.threads.defaultExecutionOptions({ threadId })) as unknown as typeof eff; } catch {}
      const access = (await accessFor(threadId)) ?? eff.permissionMode ?? null;
      const provName = (await catalog().catch(() => [])).find((p) => p.id === providerId)?.name ?? providerId;
      return {
        id: t.id,
        projectId: t.projectId,
        projectName: names.get(t.projectId) ?? "",
        machine,
        exec: { providerId, providerName: provName, model: eff.model ?? null, modelName: await modelName(providerId, eff.model ?? null), reasoning: eff.reasoningLevel ?? null, access },
        title: titleOf(dto),
        status: statusOf(dto),
        unread: isUnread(dto),
        pinned: Boolean(dto.pinnedAt),
        rec: rec && lastMsg?.role === "assistant" && rec.forAt === lastMsg.at ? { forAt: rec.forAt, pills: rec.pills, recommended: rec.recommended, reason: rec.reason, stake: rec.stake ?? "" } : null,
        messages: [
          ...messages,
          // The timeline can pick a message up between the two reads.
          ...waiting.filter((w) => !messages.some((m) => m.role === "user" && m.text === w.text && m.at >= w.at - 1000)),
        ].slice(-MESSAGES_MAX),
        interactions,
      };
    },

    async send({ threadId, text, files }) {
      const attached = files?.length ? await attach((await bb.sdk.threads.get({ threadId })).projectId, files) : [];
      const permissionMode = await accessFor(threadId);
      const result = await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [...(text ? [{ type: "text" as const, text, mentions: [] }] : []), ...attached],
        ...(permissionMode ? { permissionMode } : {}),
      });
      return { delivery: result.delivery };
    },

    async start({ projectId, text, files, providerId, model, reasoningLevel, hostId, permissionMode }) {
      // A chosen machine runs in that machine's copy of the project.
      let environment: any = { type: "project-default" };
      if (hostId) {
        const p = (await bb.sdk.projects.get({ projectId })) as unknown as { sources?: Array<{ hostId: string; path: string }> };
        const src = p.sources?.find((s) => s.hostId === hostId);
        if (src) environment = { type: "host", hostId, workspace: { type: "unmanaged", path: src.path } };
      }
      const t = await bb.sdk.threads.spawn({
        projectId,
        environment,
        ...(files?.length
          ? { input: [{ type: "text" as const, text, mentions: [] }, ...(await attach(projectId, files))] }
          : { prompt: text }),
        origin: "app",
        ...(providerId ? { providerId } : {}),
        ...(model ? { model } : {}),
        ...(reasoningLevel ? { reasoningLevel: reasoningLevel as any } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      });
      return { threadId: t.id };
    },

    async approve({ threadId, interactionId, decision }) {
      await bb.sdk.threads.interactions.resolve({
        threadId,
        interactionId,
        resolution: decision === "deny" ? { decision } : { decision, grantedPermissions: null },
      });
      return { ok: true };
    },

    async answer({ threadId, interactionId, answers }) {
      await bb.sdk.threads.interactions.resolve({
        threadId,
        interactionId,
        resolution: { kind: "user_answer", answers },
      });
      return { ok: true };
    },

    async stop({ threadId }) {
      await bb.sdk.threads.stop({ threadId });
      return { ok: true };
    },

    async setRead({ threadId, read }) {
      await (read ? bb.sdk.threads.markRead({ threadId }) : bb.sdk.threads.markUnread({ threadId }));
      return { ok: true };
    },

    async setPinned({ threadId, pinned }) {
      await (pinned ? bb.sdk.threads.pin({ threadId }) : bb.sdk.threads.unpin({ threadId }));
      return { ok: true };
    },

    async done({ threadId }) {
      const children = await bb.sdk.threads.list({ parentThreadId: threadId, archived: false, limit: 1 });
      if (children.length > 0) {
        return { ok: false, reason: "This thread has live child threads, and archiving it would archive them too. Use full bb for this one." };
      }
      await bb.sdk.threads.archive({ threadId });
      return { ok: true, reason: null };
    },

    async transcribe({ audio, mime, heard }) {
      const bytes = Buffer.from(audio, "base64");
      const file = audioFile(bytes, mime);
      const prompt = await vocabularyHint();
      // OpenAI first: it takes the vocabulary hint and doesn't depend on the
      // server's Codex login, which expires. bb's own transcription is the fallback.
      const key = await openaiKey();
      let firstError: string | null = null;
      if (key) {
        const form = new FormData();
        form.set("model", (await settings.get()).transcribeModel || "gpt-4o-transcribe");
        form.set("language", "en");
        if (prompt) form.set("prompt", prompt);
        form.set("response_format", "json");
        form.append("include[]", "logprobs");
        form.set("file", file);
        const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: form,
        });
        const body = (await res.json().catch(() => null)) as
          | { text?: string; logprobs?: Array<{ logprob: number }>; error?: { message?: string } }
          | null;
        if (res.ok && typeof body?.text === "string") {
          const text = body.text.trim();
          if (echoesHint(text, prompt)) {
            bb.log.info(`transcript dropped as hint echo: ${text.slice(0, 80)}`);
            return { text: "" };
          }
          // Measured 2026-09-24: clean speech averaged -0.13 or better; text the
          // model invented from silence or faint noise averaged -1.3 to -3.1.
          // But a real phrase clipped mid-word scored -1.17, so when the page's
          // meter heard at least half a second of speech-level sound the bar is
          // looser, and it's strict only when the meter heard next to nothing.
          const lp = body.logprobs ?? [];
          const mean = lp.length ? lp.reduce((s, x) => s + x.logprob, 0) / lp.length : 0;
          // AirPods on a plane (9/24): -1.95 got through at -2 and was surely noise.
          const bar = (heard ?? 0) >= 30 ? -1.5 : -0.5;
          if (mean < bar) {
            bb.log.info(`transcript dropped as low confidence (${mean.toFixed(2)} < ${bar}, heard ${heard ?? "?"}): ${text.slice(0, 80)}`);
            return { text: "" };
          }
          bb.log.info(`transcript kept (${mean.toFixed(2)}, heard ${heard ?? "?"}, ${text.length} chars)`);
          return { text };
        }
        firstError = body?.error?.message ?? `OpenAI ${res.status}`;
        bb.log.warn(`openai transcription failed: ${firstError}`);
      }
      try {
        const { text } = await bb.sdk.system.transcribeVoice({ file, prompt });
        return { text: echoesHint(text, prompt) ? "" : text.trim() };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(firstError ? `Transcription failed (${firstError}; bb: ${msg})` : `Transcription failed: ${msg}`);
      }
    },

    async artifacts() {
      const [items, seen] = await Promise.all([artifacts(), seenSet()]);
      return {
        items: items.map((a) => ({
          id: a.id,
          kind: a.kind,
          label: a.label,
          target: a.isFile ? a.target.replace(homedir(), "~") : a.target,
          isFile: a.isFile,
          at: a.at,
          source: a.source,
          threadId: a.threadId,
          threadTitle: a.threadTitle,
          seen: !isNew(a, seen),
          primary: isPrimary(a),
        })),
      };
    },

    async shortcutKey({ rotate }) {
      let key = await bb.storage.kv.get<string>("tellKey");
      if (!key || rotate) {
        key = randomBytes(18).toString("base64url");
        await bb.storage.kv.set("tellKey", key);
      }
      return { key };
    },

    async tell({ key, text }) {
      const want = await bb.storage.kv.get<string>("tellKey");
      const a = Buffer.from(key), b = Buffer.from(want ?? "");
      if (!want || a.length !== b.length || !timingSafeEqual(a, b)) {
        return { ok: false, reason: "bad-key", threadId: null, title: null, delivery: null };
      }
      const managers = await managerIds();
      const list = (await bb.sdk.threads.list({ archived: false, limit: 300 })) as Dto[];
      const mgr = await chooseManager(list, managers);
      const target = list.find((t) => t.id === mgr.id);
      if (!target) return { ok: false, reason: "no-manager", threadId: null, title: null, delivery: null };
      const permissionMode = await accessFor(target.id);
      const r = await bb.sdk.threads.send({ threadId: target.id, mode: "auto", input: [{ type: "text", text, mentions: [] }], ...(permissionMode ? { permissionMode } : {}) });
      bb.log.info(`tell -> ${target.id} (${text.length} chars, ${r.delivery})`);
      return { ok: true, reason: null, threadId: target.id, title: titleOf(target), delivery: r.delivery };
    },

    async voiceLog(entry) {
      bb.log.info(`voice ${JSON.stringify(entry)}`);
      return { ok: true };
    },

    async drafts({ fresh }) {
      if (!fresh && draftsCache && Date.now() - draftsCache.at < 60_000) return draftsCache.value;
      const value = await loadDrafts();
      draftsCache = { at: Date.now(), value };
      return value;
    },

    async draftBody({ id }) {
      await refreshGwsCfg();
      const g = await gws<{ message: { payload?: any } }>(
        ["gmail", "users", "drafts", "get", "--params", JSON.stringify({ userId: "me", id, format: "full" })],
      );
      const p = g.message.payload ?? {};
      const h = (n: string) => (p.headers ?? []).find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
      const find = (part: any): string | null => {
        if (part?.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
        for (const c of part?.parts ?? []) { const r = find(c); if (r) return r; }
        return null;
      };
      let body = find(p) ?? "";
      // Leave the quoted thread out of a phone preview.
      const cut = body.search(/\n\s*On .{5,200} wrote:\s*\n/);
      if (cut > 0) body = `${body.slice(0, cut).trimEnd()}\n\n[earlier messages in Gmail]`;
      return { to: h("To"), cc: h("Cc"), subject: h("Subject"), body: body.trim() };
    },

    async dismissDraft({ key }) {
      const set = new Set((await bb.storage.kv.get<string[]>("draftsDismissed")) ?? []);
      set.add(key);
      await bb.storage.kv.set("draftsDismissed", [...set].slice(-1000));
      if (draftsCache) draftsCache.at = 0;
      return { ok: true };
    },

    async setGmailLink({ style }) {
      await bb.storage.kv.set("gmailLink", style);
      bb.log.info(`drafts: phone Gmail link set to ${style}`);
      if (draftsCache) draftsCache.at = 0;
      return { ok: true };
    },

    async dismiss({ threadId, undo, wasUnread }) {
      if (undo) {
        await bb.storage.kv.delete(`dismissed:${threadId}`);
        if (wasUnread) await bb.sdk.threads.markUnread({ threadId });
        return { ok: true };
      }
      const t = (await bb.sdk.threads.get({ threadId })) as unknown as Dto;
      await bb.storage.kv.set(`dismissed:${threadId}`, t.latestAttentionAt ?? 0);
      await bb.sdk.threads.markRead({ threadId });
      const dl = (await bb.storage.kv.get<Array<Record<string, unknown>>>("dismissLog")) ?? [];
      dl.push({ at: Date.now(), threadId, attn: t.latestAttentionAt ?? 0 });
      await bb.storage.kv.set("dismissLog", dl.slice(-1000));
      bb.log.info(`dismissed ${threadId}`);
      return { ok: true };
    },

    async catalog() {
      return { providers: await catalog() };
    },

    async projectSetup({ projectId }) {
      const [d, p, hs] = await Promise.all([
        bb.sdk.projects.defaultExecutionOptions({ projectId }).catch(() => ({})) as Promise<any>,
        bb.sdk.projects.get({ projectId }) as Promise<any>,
        hosts(),
      ]);
      const machines = ((p?.sources ?? []) as Array<{ hostId: string; isDefault?: boolean }>)
        .map((s) => { const h = hs.find((x) => x.id === s.hostId); return { hostId: s.hostId, name: h?.name ?? s.hostId, online: Boolean(h?.online), isDefault: Boolean(s.isDefault) }; });
      return { defaults: { providerId: d?.providerId ?? null, model: d?.model ?? null, reasoningLevel: d?.reasoningLevel ?? null }, machines };
    },

    async setAccess({ threadId, mode }) {
      await bb.storage.kv.set(`access:${threadId}`, mode);
      bb.log.info(`access ${threadId} -> ${mode} (from the next message)`);
      return { ok: true };
    },

    async setModel({ threadId, model, reasoningLevel }) {
      await bb.sdk.threads.update({ threadId, model, ...(reasoningLevel ? { reasoningLevel: reasoningLevel as any } : {}) });
      return { ok: true };
    },

    async setManager({ threadId }) {
      if (threadId) await bb.storage.kv.set("managerOverride", threadId);
      else await bb.storage.kv.delete("managerOverride");
      return { ok: true };
    },

    async suggestTitle({ threadId }) {
      const key = await openaiKey();
      if (!key) throw new Error("Add an OpenAI key in Pocket's settings to use ✨");
      const tl = await bb.sdk.threads.timeline({ threadId, segmentLimit: "40" });
      const conv = (tl.rows as Array<Record<string, unknown>>).filter((r) => r.kind === "conversation" && typeof r.text === "string" && (r.text as string).trim());
      const first = conv.find((r) => r.role === "user")?.text as string | undefined;
      const lastAgent = [...conv].reverse().find((r) => r.role === "assistant")?.text as string | undefined;
      const model = (await settings.get()).suggestModel || "gpt-5.6-luna";
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model, ...reasoning(model, "none"),
          messages: [
            { role: "system", content: "Name this conversation between a person and their AI agent. Reply with the title only: at most 5 words, sentence case, specific (name the client, project or deliverable), no quotes, no trailing punctuation, no emoji." },
            { role: "user", content: `How it started:\n"""${(first ?? "").slice(0, 2000)}"""\n\nWhere it is now:\n"""${(lastAgent ?? "").slice(-2000)}"""` },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      const title = (body.choices?.[0]?.message?.content ?? "").trim().replace(/^["'“”]+|["'“”.]+$/g, "").split(/\s+/).slice(0, 6).join(" ");
      if (!title) throw new Error("No title came back; try again");
      return { title };
    },

    async rename({ threadId, title }) {
      await bb.sdk.threads.update({ threadId, title });
      return { ok: true };
    },

    async fileRefs({ threadId, paths }) {
      const files = await Promise.all([...new Set(paths)].map(async (path) => {
        const f = await resolveLink(threadId, path).catch(() => null);
        if (!f) return { path, ok: false, found: null, kind: "", name: "" };
        return { path, ok: true, found: await fileExists(f), kind: f.kind, name: f.name };
      }));
      return { files };
    },

    async fileText({ threadId, path }) {
      const f = await resolveLink(threadId, path).catch(() => null);
      if (!f) return { found: false, name: "", text: "", truncated: false };
      try {
        const buf = await readLinked(f);
        const MAX = 400_000;
        return { found: true, name: f.name, text: buf.subarray(0, MAX).toString("utf8"), truncated: buf.length > MAX };
      } catch {
        return { found: false, name: f.name, text: "", truncated: false };
      }
    },

    async threadRefs({ ids }) {
      const names = await projectNames();
      const threads = await Promise.all([...new Set(ids)].map(async (id) => {
        const hit = refCache.get(id);
        if (hit && Date.now() - hit.at < (hit.ref.found ? REF_TTL : REF_MISS_TTL)) return hit.ref;
        let ref = { id, found: false, title: "", projectName: "", archived: false };
        try {
          const t = (await bb.sdk.threads.get({ threadId: id })) as unknown as Dto & { archivedAt?: number | null };
          ref = { id, found: true, title: titleOf(t), projectName: names.get(t.projectId) ?? "", archived: Boolean(t.archivedAt) };
        } catch {}
        refCache.set(id, { at: Date.now(), ref });
        return ref;
      }));
      return { threads };
    },

    async search({ query }) {
      const [res, names] = await Promise.all([
        bb.sdk.threads.search({ query, limitPerGroup: "25" }) as Promise<any>,
        projectNames(),
      ]);
      const groups: Array<{ results?: Array<{ thread: Dto & { archivedAt: number | null }; matches: Array<{ sourceKind: string; text: string; highlightRanges?: Array<{ start: number; end: number }> }> }> }> = [res?.active ?? {}, res?.archived ?? {}];
      const WHERE: Record<string, string> = { title: "title", title_fallback: "first message", user_message: "you said", assistant_message: "agent said" };
      const threads = groups.flatMap((g) => g.results ?? []).map((r) => {
        const t = r.thread;
        // Show the most telling match: a message beats a title, which is already shown.
        const m = r.matches.find((x) => x.sourceKind === "assistant_message" || x.sourceKind === "user_message") ?? r.matches[0];
        return {
          id: t.id, title: titleOf(t), projectName: names.get(t.projectId) ?? "", archived: Boolean(t.archivedAt), updatedAt: lastActive(t),
          snippet: m && m.sourceKind !== "title" ? m.text.slice(0, 220) : null,
          ranges: (m && m.sourceKind !== "title" ? m.highlightRanges ?? [] : []).filter((h) => h.end <= 220).map((h) => [h.start, h.end] as [number, number]),
          where: m ? WHERE[m.sourceKind] ?? "" : "",
        };
      }).slice(0, 40);
      const q = query.toLowerCase();
      const [items, seen] = await Promise.all([artifacts().catch(() => [] as Merged[]), seenSet()]);
      const arts = items.filter((a) => a.label.toLowerCase().includes(q) || a.target.toLowerCase().includes(q) || (a.threadTitle ?? "").toLowerCase().includes(q)).slice(0, 12)
        .map((a) => ({ id: a.id, kind: a.kind, label: a.label, target: a.isFile ? a.target.replace(homedir(), "~") : a.target, isFile: a.isFile, at: a.at, source: a.source, threadId: a.threadId, threadTitle: a.threadTitle, seen: !isNew(a, seen), primary: isPrimary(a) }));
      return { threads, artifacts: arts };
    },

    async pillStats({ sinceDays }) {
      const since = Date.now() - (sinceDays ?? 7) * DAY;
      const recs = ((await bb.storage.kv.get<Array<Record<string, any>>>("recLog")) ?? []).filter((r) => r.at >= since);
      const taps = ((await bb.storage.kv.get<Array<Record<string, any>>>("pillTaps")) ?? []).filter((r) => r.at >= since);
      const dismisses = ((await bb.storage.kv.get<Array<Record<string, any>>>("dismissLog")) ?? []).filter((r) => r.at >= since);
      // What happened after each recommendation: the recommended pill, another
      // pill, some other reply (typed or voice), a dismiss, or nothing yet.
      const outcomes = await Promise.all(recs.slice(-80).map(async (r) => {
        const tapsHere = taps.filter((x) => x.threadId === r.threadId && x.at >= r.at);
        let outcome = "none";
        if (tapsHere.some((x) => x.recommended)) outcome = "tapped_recommended";
        else if (tapsHere.length) outcome = "tapped_other_pill";
        else if (dismisses.some((d) => d.threadId === r.threadId && d.at >= r.at)) outcome = "dismissed";
        else {
          try {
            const tl = await bb.sdk.threads.timeline({ threadId: r.threadId, segmentLimit: "6" });
            const replied = (tl.rows as Array<Record<string, unknown>>).some((x) => x.kind === "conversation" && x.role === "user" && typeof x.createdAt === "number" && x.createdAt > r.forAt);
            if (replied) outcome = "replied_other_way";
          } catch { /* thread gone */ }
        }
        return { ...r, outcome };
      }));
      const count = (o: string) => outcomes.filter((x) => x.outcome === o).length;
      return {
        summary: {
          days: sinceDays ?? 7,
          recommendations: outcomes.length,
          tapped_recommended: count("tapped_recommended"),
          tapped_other_pill: count("tapped_other_pill"),
          replied_other_way: count("replied_other_way"),
          dismissed: count("dismissed"),
          no_action: count("none"),
          pill_taps_total: taps.length,
          pill_taps_on_fresh_threads: taps.filter((x) => !x.stale).length,
          pill_taps_from_home: taps.filter((x) => x.source === "home").length,
        },
        recs: outcomes,
        taps,
      };
    },

    async pillLog(entry) {
      const log = (await bb.storage.kv.get<Array<Record<string, unknown>>>("pillTaps")) ?? [];
      log.push({ at: Date.now(), ...entry });
      await bb.storage.kv.set("pillTaps", log.slice(-2000));
      bb.log.info(`pill tap ${JSON.stringify(entry)}`);
      return { ok: true };
    },

    async suggest({ threadId }) {
      const [t, timeline] = await Promise.all([
        bb.sdk.threads.get({ threadId }),
        bb.sdk.threads.timeline({ threadId, segmentLimit: "6" }),
      ]);
      const rows = (timeline.rows as Array<Record<string, unknown>>).filter((r) => r.kind === "conversation" && typeof r.text === "string" && (r.text as string).trim());
      const last = rows[rows.length - 1];
      // Only when the agent spoke last and is done.
      if (!last || last.role !== "assistant" || isWorking(statusOf(t as unknown as Dto)) || (t as any).hasPendingInteraction) return { forAt: 0, pills: [] };
      const forAt = typeof last.createdAt === "number" ? last.createdAt : 0;
      const prevUser = [...rows].reverse().find((r) => r.role === "user");
      return cachedPills(threadId, forAt, last.text as string, prevUser ? (prevUser.text as string) : null);
    },

    async threadArtifacts({ threadId }) {
      const [items, seen] = await Promise.all([artifactsForThread(threadId), seenSet()]);
      return {
        items: items.map((a) => ({
          id: a.id, kind: a.kind, label: a.label,
          target: a.isFile ? a.target.replace(homedir(), "~") : a.target,
          isFile: a.isFile, at: a.at, source: a.source, threadId: a.threadId, threadTitle: a.threadTitle,
          seen: !isNew(a, seen), primary: isPrimary(a),
        })),
      };
    },

    async artifactsSeen({ ids }) {
      await markSeen(ids);
      return { ok: true };
    },

    async registerDevice({ token, env, bundleId }) {
      const list = await devices();
      const now = Date.now();
      const t = token.toLowerCase();
      const prev = list.find((d) => d.token === t);
      if (prev) Object.assign(prev, { env, bundleId, lastSeen: now });
      else list.push({ token: t, env, bundleId, addedAt: now, lastSeen: now });
      await bb.storage.kv.set("devices", list);
      bb.log.info(`device ${prev ? "seen" : "registered"} …${t.slice(-6)} (${env}, ${list.length} total)`);
      return { ok: true };
    },

    async testNotification() {
      const payload = buildTestPayload();
      const r = await deliverPayload(payload, "pocket-test", "test", JSON.stringify(payload));
      return { dryRun: r.dryRun, devices: r.results.length, results: r.results, payload: JSON.stringify(payload, null, 2) };
    },

    async notifyStatus() {
      const { cfg, keyReady, dryRun, want } = await pushState();
      const prefs = await loadPrefs();
      return {
        serverOn: cfg.notifications === true,
        keyReady,
        dryRun,
        quietNow: inQuietHours(prefs),
        prefs,
        devices: (await devices()).map((d) => ({ id: d.token.slice(-6), env: d.env, bundleId: d.bundleId, matches: !want || d.bundleId === want, addedAt: d.addedAt, lastSeen: d.lastSeen })),
      };
    },

    async setNotifyPrefs(input) {
      const prefs = normalizePrefs(input);
      await bb.storage.kv.set("notifyPrefs", prefs);
      bb.log.info(`notify prefs: ${JSON.stringify(prefs)}`);
      return { ok: true };
    },

    async about() {
      const pkg = JSON.parse((await asset("package.json")).toString("utf8")) as { version?: string };
      const pocketChangelog = await asset("CHANGELOG.md").then((b) => b.toString("utf8")).catch(() => "");
      const path = ((await settings.get()).iosChangelogFile || "").trim();
      let iosChangelog: string | null = null;
      if (path) {
        try { iosChangelog = (await readFile(expandHome(path), "utf8")).slice(0, 200_000); } catch { iosChangelog = null; }
      }
      return { pocketVersion: pkg.version ?? "?", pocketChangelog: pocketChangelog.slice(0, 200_000), iosChangelog };
    },

    async forgetDevice({ id }) {
      const list = await devices();
      const kept = list.filter((d) => d.token.slice(-6) !== id);
      if (kept.length === list.length) throw new Error("No device with that id");
      await bb.storage.kv.set("devices", kept);
      bb.log.info(`device forgotten …${id}`);
      return { ok: true };
    },
  });

  // ---- HTTP ---------------------------------------------------------------
  bb.http.route("GET", "/app", async () => {
    // talk.js (the Walk transcript and Conversations helpers, shared with the
    // tests) goes inline, so the page never runs without it.
    const talk = (await asset("talk.js")).toString("utf8");
    const html = (await asset("page.html")).toString("utf8").replace(TALK_TAG, () => `<script>\n${talk}</script>`);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  });

  // Opening an artifact. Only ids Pocket itself listed resolve, so this is not
  // a general file server. Files go through a short-lived bb preview URL on
  // the host that holds them; links redirect.
  bb.http.route("GET", "/open", async (c) => {
    const id = c.req.query("id") ?? "";
    const page = (title: string, body: string, status = 404) =>
      new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:17px/1.45 -apple-system,system-ui;padding:28px;color:#1c1b19;background:#f6f5f1"><h2 style="margin:0 0 8px">${title}</h2><p style="color:#75716a">${body}</p><p><a href="app#/artifacts">Back to artifacts</a></p></body>`,
        { status, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    let item = (artifactCache?.items ?? []).find((a) => a.id === id) ?? threadArtifactIndex.get(id);
    if (!item) item = (await artifacts(true)).find((a) => a.id === id);
    if (!item) return page("Not found", "That artifact isn't in Pocket's list any more.");
    await markSeen([item.id]);
    if (!item.isFile) return Response.redirect(item.target, 302);

    const { primaryHostId } = (await bb.sdk.system.config()) as { primaryHostId?: string };
    const hostId = item.hostId ?? primaryHostId;
    if (!hostId || hostId === primaryHostId) {
      try { await stat(item.target); } catch {
        return page("File not found", `<code>${item.target.replace(homedir(), "~")}</code> has been moved or deleted.`);
      }
    }
    try {
      const preview = await bb.sdk.files.createPreview({ hostId, rootPath: dirname(item.target), ttlMs: 30 * 60_000 });
      return new Response(null, {
        status: 302,
        headers: { location: `${previewPath(preview.baseUrl)}/${encodeURIComponent(basename(item.target))}` },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return page("Can't open this file right now", `It lives on a machine bb can't reach (${msg.slice(0, 160)}). If that's the Mac, it's probably asleep.`, 503);
    }
  });

  // A file linked in a message. Images come back as bytes (Pocket's viewer
  // shows them); pages, PDFs and the rest go through a bb preview URL, the way
  // bb web shows HTML. A missing file gets a quiet page, never an error.
  const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif" };
  bb.http.route("GET", "/file", async (c) => {
    const threadIdQ = c.req.query("t") ?? "";
    const quiet = (title: string, body: string, status = 404) =>
      new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:17px/1.45 -apple-system,system-ui;padding:28px;color:#75716a;background:#f6f5f1"><h2 style="margin:0 0 8px;color:#1c1b19">${title}</h2><p>${body}</p></body>`,
        { status, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    if (!/^thr_[a-z0-9]+$/.test(threadIdQ)) return quiet("File not found", "");
    const f = await resolveLink(threadIdQ, c.req.query("p") ?? "").catch(() => null);
    if (!f) return quiet("File not found", "");
    const shown = f.path.replace(homedir(), "~").replace(/[<>&]/g, "");
    if ((await fileExists(f)) === false) return quiet("File not found", `<code>${shown}</code> has been moved or deleted.`);
    try {
      const type = IMAGE_TYPES[extname(f.path).toLowerCase()];
      if (type) return new Response(new Uint8Array(await readLinked(f)), { headers: { "content-type": type, "cache-control": "private, max-age=60", "content-security-policy": "sandbox" } });
      return new Response(null, { status: 302, headers: { location: await previewUrl(f) } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return quiet("Can't open this file right now", `It lives on a machine bb can't reach (${msg.slice(0, 160).replace(/[<>&]/g, "")}). If that's the Mac, it's probably asleep.`, 503);
    }
  });

  // A file attached to one of your messages. Only paths that thread's own
  // messages carry are served, read through bb's project attachment store.
  bb.http.route("GET", "/att", async (c) => {
    const threadIdQ = c.req.query("t") ?? "";
    const path = c.req.query("p") ?? "";
    const nope = () => new Response("Not found", { status: 404 });
    if (!/^thr_[a-z0-9]+$/.test(threadIdQ) || !path) return nope();
    try {
      const [t, tl] = await Promise.all([
        bb.sdk.threads.get({ threadId: threadIdQ }),
        bb.sdk.threads.timeline({ threadId: threadIdQ, segmentLimit: "100" }),
      ]);
      const owned = (tl.rows as Array<Record<string, unknown>>).some((r) => rowFiles(r).some((f) => f.path === path));
      if (!owned) return nope();
      const r = await bb.sdk.projects.attachments.read({ projectId: t.projectId, path });
      const name = basename(path).replace(/["\\\r\n]/g, "");
      return new Response(new Uint8Array(r.bytes), {
        headers: {
          "content-type": r.mimeType || "application/octet-stream",
          "content-disposition": `inline; filename="${name}"`,
          "cache-control": "private, max-age=3600",
          "content-security-policy": "sandbox",
        },
      });
    } catch {
      return nope();
    }
  });

  // The recorder's capture worklet: raw 16-bit samples, the same path Walk
  // uses. MediaRecorder went silent on routes Walk still heard (9/25: iPhone
  // plugged into a Mac as its audio device), so notes are captured this way.
  bb.http.route("GET", "/capture.js", () =>
    new Response(CAPTURE_WORKLET, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } }),
  );

  bb.http.route("GET", "/icon.png", async () => {
    const png = await asset("icon.png");
    return new Response(png, {
      headers: { "content-type": "image/png", "cache-control": "max-age=86400" },
    });
  });

  bb.http.route("GET", "/manifest.webmanifest", () =>
    Response.json({
      name: "bb Pocket",
      short_name: "Pocket",
      start_url: "./app",
      scope: "./",
      display: "standalone",
      background_color: "#f6f5f1",
      theme_color: "#f6f5f1",
      icons: [{ src: "./icon.png", sizes: "512x512", type: "image/png" }],
    }),
  );

  bb.log.info("pocket loaded: /api/v1/plugins/pocket/http/app");
}
