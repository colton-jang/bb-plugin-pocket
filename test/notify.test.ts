// Unit tests for notify.ts: the provider token, the payload contract, and the
// rules for when and with what choices to notify. Run: npm test
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import {
  RateLimit, apnsHeaders, apnsJwt, buildPayload, interactionNotice, isDeadToken, plainText, redacted, replyChoices, verdict,
} from "../notify.ts";

const T = 1_800_000_000_000;
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

test("provider token: ES256 header with kid, iss/iat claims, raw 64-byte signature that verifies", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwt = apnsJwt(pem, "KEYID12345", "TEAMID1234", 1_800_000_000);
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(decode(h), { alg: "ES256", kid: "KEYID12345" });
  assert.deepEqual(decode(c), { iss: "TEAMID1234", iat: 1_800_000_000 });
  const sig = Buffer.from(s, "base64url");
  assert.equal(sig.length, 64);
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig));
  assert.ok(!/[=+/]/.test(jwt), "base64url, unpadded");
});

test("payload: reply with choices and a recommendation matches the contract", () => {
  const p = buildPayload({
    threadId: "thr_abc", kind: "reply", title: "Deck review", body: "Done. Want me to tighten slide 4?", forAt: T,
    choices: [{ label: "Yes", text: "Yes, tighten it." }, { label: "No", text: "Leave it." }], recommended: 0,
  });
  assert.deepEqual(p, {
    aps: {
      alert: { title: "Deck review", body: "Done. Want me to tighten slide 4?" },
      sound: "default", "thread-id": "thr_abc", category: "POCKET_REPLY", "mutable-content": 1,
    },
    pocket: { threadId: "thr_abc", kind: "reply", forAt: T, choices: [{ label: "Yes", text: "Yes, tighten it." }, { label: "No", text: "Leave it." }], recommended: 0 },
  });
});

test("payload: approval carries interactionId, no choices; at most 3 choices; bad recommended dropped", () => {
  const a = buildPayload({ threadId: "thr_abc", kind: "approval", title: "t", body: "Run a command: ls", forAt: T, interactionId: "int_1" });
  assert.equal(a.aps.category, "POCKET_APPROVAL");
  assert.deepEqual(a.pocket, { threadId: "thr_abc", kind: "approval", forAt: T, interactionId: "int_1" });
  const four = [1, 2, 3, 4].map((i) => ({ label: `L${i}`, text: `T${i}` }));
  const q = buildPayload({ threadId: "thr_abc", kind: "question", title: "t", body: "b", forAt: T, interactionId: "int_2", choices: four, recommended: 3 });
  assert.equal(q.aps.category, "POCKET_QUESTION");
  assert.equal((q.pocket.choices as unknown[]).length, 3);
  assert.equal("recommended" in q.pocket, false);
  const long = buildPayload({ threadId: "thr_abc", kind: "reply", title: "x".repeat(100), body: "y".repeat(300), forAt: T });
  assert.ok(long.aps.alert.body.length <= 140 && long.aps.alert.body.endsWith("…"));
  assert.ok(long.aps.alert.title.length <= 60);
  assert.equal("choices" in long.pocket, false);
});

test("headers: alert push, topic, collapse by thread, priority 10", () => {
  assert.deepEqual(apnsHeaders("com.example.pocket", "thr_abc", "JWT"), {
    authorization: "bearer JWT", "apns-push-type": "alert", "apns-topic": "com.example.pocket", "apns-collapse-id": "thr_abc", "apns-priority": "10",
  });
});

test("log copy cuts the body and choice texts", () => {
  const r = redacted(buildPayload({ threadId: "thr_abc", kind: "reply", title: "t", body: "z".repeat(120), forAt: T, choices: [{ label: "Go", text: "w".repeat(90) }] }));
  assert.ok(r.aps.alert.body.length <= 40);
  assert.ok((r.pocket.choices as Array<{ text: string }>)[0].text.length <= 40);
});

test("body text: markdown flattened to one plain line", () => {
  assert.equal(plainText("## Done\n\n- **Built** the [deck](docs/deck.pdf)\n- `npm test` passes\n\n```\ncode\n```\nShip it?"), "Done Built the deck npm test passes Ship it?");
  assert.equal(plainText("a".repeat(200)).length, 140);
});

test("approval notice: summary and detail", () => {
  const n = interactionNotice("thr_abc", "Title", { id: "int_1", createdAt: T, payload: { kind: "approval", reason: null, subject: { kind: "command", command: "rm -rf build" }, availableDecisions: ["allow_once", "deny"] } });
  assert.deepEqual(n, { threadId: "thr_abc", kind: "approval", title: "Title", body: "Run a command: rm -rf build", forAt: T, interactionId: "int_1" });
});

test("question notice: one single-select question gives ≤3 safe choices (text = option value)", () => {
  const options = [
    { label: "Option A", value: "a" }, { label: "Delete it", value: "del" }, { label: "Option B", value: "b" }, { label: "Option C", value: "c" }, { label: "Option D", value: "d" },
  ];
  const n = interactionNotice("thr_abc", "T", { id: "int_2", createdAt: T, payload: { kind: "user_question", questions: [{ id: "q1", prompt: "Which one?", multiSelect: false, options }] } });
  assert.equal(n?.kind, "question");
  assert.equal(n?.body, "Which one?");
  assert.deepEqual(n?.choices, [{ label: "Option A", text: "a" }, { label: "Option B", text: "b" }, { label: "Option C", text: "c" }]);
  assert.equal(n?.questionId, "q1");
  assert.equal(buildPayload(n!).pocket.questionId, "q1");
  assert.equal(buildPayload(n!).pocket.allowFreeText, false, "no typed answers unless the question allows them");
  const multi = interactionNotice("thr_abc", "T", { id: "int_3", createdAt: T, payload: { kind: "user_question", questions: [{ id: "q1", prompt: "One?", options }, { id: "q2", prompt: "Two?", options }] } });
  assert.equal(multi?.body, "One? (+1 more)");
  assert.equal(multi?.choices, undefined);
  assert.equal(multi?.questionId, undefined);
  const ms = interactionNotice("thr_abc", "T", { id: "int_4", createdAt: T, payload: { kind: "user_question", questions: [{ id: "q1", prompt: "Pick", multiSelect: true, options }] } });
  assert.equal(ms?.choices, undefined);
  assert.equal(interactionNotice("thr_abc", "T", { id: "int_5", createdAt: T, payload: { kind: "something_else" } }), null);
});

test("reply choices: the recommendation for this message leads; else cached pills; unsafe ones never", () => {
  const pills = [{ label: "Yes", text: "Yes." }, { label: "Send it", text: "Send the email now." }, { label: "No", text: "No." }, { label: "Later", text: "Later." }, { label: "Maybe", text: "Maybe." }];
  assert.deepEqual(replyChoices(T, null, { forAt: T, pills }), { choices: [{ label: "Yes", text: "Yes." }, { label: "No", text: "No." }, { label: "Later", text: "Later." }] });
  assert.deepEqual(replyChoices(T, null, { forAt: T - 1, pills }), { choices: [] });
  const rec = { forAt: T, pills: [{ label: "A", text: "a" }, { label: "B", text: "b" }, { label: "C", text: "c" }, { label: "D", text: "d" }], recommended: 2 };
  assert.deepEqual(replyChoices(T, rec, { forAt: T, pills }), { choices: [{ label: "C", text: "c" }, { label: "A", text: "a" }, { label: "B", text: "b" }], recommended: 0 });
  // A recommendation for an earlier message doesn't apply.
  assert.deepEqual(replyChoices(T, { ...rec, forAt: T - 5 }, null), { choices: [] });
  // No pick: alternatives only, nothing marked recommended.
  assert.deepEqual(replyChoices(T, { ...rec, recommended: -1 }, null), { choices: rec.pills.slice(0, 3) });
});

test("verdict: dedupe per message, no backlog, skip what you've read", () => {
  const cutoff = T - 30 * 60_000;
  assert.equal(verdict({ forAt: T, handledForAt: 0, cutoff, lastReadAt: null, needsUnread: true }), "notify");
  assert.equal(verdict({ forAt: T, handledForAt: T, cutoff, lastReadAt: null, needsUnread: true }), "done");
  assert.equal(verdict({ forAt: T - 5, handledForAt: T, cutoff, lastReadAt: null, needsUnread: true }), "done");
  assert.equal(verdict({ forAt: cutoff - 1, handledForAt: 0, cutoff, lastReadAt: null, needsUnread: true }), "old");
  assert.equal(verdict({ forAt: T, handledForAt: 0, cutoff, lastReadAt: T + 10, needsUnread: true }), "read");
  assert.equal(verdict({ forAt: T, handledForAt: 0, cutoff, lastReadAt: T + 10, needsUnread: false }), "notify");
});

test("rate limit: 6 a minute, sliding", () => {
  const r = new RateLimit(6, 60_000);
  for (let i = 0; i < 6; i++) assert.ok(r.take(T + i));
  assert.equal(r.take(T + 10), false);
  assert.equal(r.take(T + 59_999), false);
  assert.ok(r.take(T + 60_000));
});

test("dead tokens: 410 and BadDeviceToken drop the device; other errors don't", () => {
  assert.ok(isDeadToken(410, "Unregistered"));
  assert.ok(isDeadToken(400, "BadDeviceToken"));
  assert.equal(isDeadToken(403, "ExpiredProviderToken"), false);
  assert.equal(isDeadToken(429, "TooManyRequests"), false);
  assert.equal(isDeadToken(200, undefined), false);
});

// ---- Notifications screen: settings, quiet hours, the safe test --------------
import { DEFAULT_PREFS, buildTestPayload, inQuietHours, normalizePrefs } from "../notify.ts";

test("settings default to everything on, quiet hours off, and clean up bad input", () => {
  assert.deepEqual(normalizePrefs(undefined), DEFAULT_PREFS);
  const p = normalizePrefs({ kinds: { reply: false }, quiet: { on: true, start: "25:00", end: "07:30", tz: "Not/AZone" } });
  assert.deepEqual(p.kinds, { approval: true, question: true, reply: false });
  assert.equal(p.quiet.start, "22:00", "an impossible time falls back to the default");
  assert.equal(p.quiet.end, "07:30");
  assert.equal(p.quiet.tz, "UTC", "an unknown time zone falls back to UTC");
});

test("quiet hours: overnight and same-day windows, in the given time zone", () => {
  const at = (iso: string) => new Date(iso);
  const night = normalizePrefs({ quiet: { on: true, start: "22:00", end: "07:00", tz: "America/Anchorage" } });
  assert.equal(inQuietHours(night, at("2026-09-28T06:30:00Z")), true, "22:30 in Anchorage is quiet");
  assert.equal(inQuietHours(night, at("2026-09-28T14:59:00Z")), true, "06:59 is quiet");
  assert.equal(inQuietHours(night, at("2026-09-28T15:00:00Z")), false, "07:00 is not");
  assert.equal(inQuietHours(night, at("2026-09-28T00:00:00Z")), false, "16:00 is not");
  const lunch = normalizePrefs({ quiet: { on: true, start: "12:00", end: "13:00", tz: "UTC" } });
  assert.equal(inQuietHours(lunch, at("2026-09-28T12:30:00Z")), true);
  assert.equal(inQuietHours(lunch, at("2026-09-28T13:00:00Z")), false);
  assert.equal(inQuietHours({ ...night, quiet: { ...night.quiet, on: false } }, at("2026-09-28T06:30:00Z")), false, "off means off");
});

test("quiet hours deliver silently: no sound, passive interruption level", () => {
  const n = { threadId: "thr_quietreply", kind: "reply" as const, title: "T", body: "B", forAt: 1 };
  const loud = buildPayload(n).aps as Record<string, unknown>;
  const quiet = buildPayload(n, { passive: true }).aps as Record<string, unknown>;
  assert.equal(loud.sound, "default");
  assert.equal(quiet.sound, undefined);
  assert.equal(quiet["interruption-level"], "passive");
  assert.equal(quiet.category, "POCKET_REPLY", "buttons still there when you look");
});

test("the test notification names no thread and has no buttons", () => {
  const p = buildTestPayload() as { aps: Record<string, unknown>; pocket: Record<string, unknown> };
  assert.equal(p.pocket.threadId, undefined);
  assert.equal(p.aps["thread-id"], undefined);
  assert.equal(p.aps.category, undefined);
  assert.equal(p.pocket.kind, "test");
});
