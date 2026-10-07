// Voice conversations: the Walk transcript runs on across a direct thread line
// and a reconnect, speakers are named (BB, or the thread's title), and the
// Conversations screen groups Talk to BB's notebook by day. talk.js is the
// same file the page runs (GET /app puts it inline). Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Script } from "node:vm";
import plugin, { TALK_TAG } from "../server.ts";
import "../talk.js";

const T = (globalThis as any).PocketTalk;
const LINE = { threadId: "thr_abc123", title: "Fix the invoice export" };

test("Walk: a direct thread line never cuts the transcript, and the thread speaks by its title", () => {
  const w = T.createWalkTranscript();
  w.start();
  w.transcript({ speaker: "you", text: "Put me through to the invoice thread." });
  w.transcript({ speaker: "assistant", text: "Sure, " });
  w.transcript({ speaker: "assistant", text: "handing you over." });
  assert.match(w.leg({ mode: "switching", to: "worker", target: LINE }), /Handing you to Fix the invoice export/);
  // Still the manager's voice until the thread's line is up.
  w.transcript({ speaker: "assistant", text: " Say take me back any time." });
  assert.match(w.leg({ mode: "worker", target: LINE }), /Talking directly to Fix the invoice export/);
  w.transcript({ speaker: "assistant", text: "You're talking to the invoice thread." });
  w.transcript({ speaker: "you", text: "Where are we?" });
  w.transcript({ speaker: "assistant", text: "Tests pass; the CSV header is left." });
  assert.match(w.leg({ mode: "switching", to: "manager", target: LINE }), /back to BB/);
  w.transcript({ speaker: "assistant", text: " Taking you back." });
  assert.equal(w.leg({ mode: "manager", target: LINE, from: "worker" }), "Back with BB.");
  w.transcript({ speaker: "assistant", text: "Back with me." });

  assert.deepEqual(w.rows.map((r: any) => [r.kind, r.name, r.threadId, r.text]), [
    ["you", "You", null, "Put me through to the invoice thread."],
    ["bb", "BB", null, "Sure, handing you over. Say take me back any time."],
    ["switch", "", null, "Talking to Fix the invoice export"],
    ["thread", "Fix the invoice export", "thr_abc123", "You're talking to the invoice thread."],
    ["you", "You", null, "Where are we?"],
    ["thread", "Fix the invoice export", "thr_abc123", "Tests pass; the CSV header is left. Taking you back."],
    ["switch", "", null, "Back with BB"],
    ["bb", "BB", null, "Back with me."],
  ]);
  assert.equal(w.voice.kind, "bb");
});

test("Walk: a reconnect keeps the transcript; a new Walk starts clean", () => {
  const w = T.createWalkTranscript();
  w.start();
  w.leg({ mode: "worker", target: LINE });
  w.transcript({ speaker: "assistant", text: "Working on it." });
  w.start({ continued: true });
  assert.equal(w.voice.name, "BB", "a new connection starts with the manager");
  w.transcript({ speaker: "assistant", text: "Still here." });
  assert.deepEqual(w.rows.map((r: any) => r.kind === "switch" ? r.text : r.name), ["Talking to Fix the invoice export", "Fix the invoice export", "Reconnected", "BB"]);
  w.start();
  assert.deepEqual(w.rows, []);
});

test("Walk: a line that never opened adds no divider and says so", () => {
  const w = T.createWalkTranscript();
  w.start();
  w.transcript({ speaker: "assistant", text: "Handing you over." });
  w.leg({ mode: "switching", to: "worker", target: LINE });
  assert.equal(w.leg({ mode: "manager", target: LINE, from: "worker" }), "Couldn't open a line to Fix the invoice export. Still with BB.");
  w.transcript({ speaker: "assistant", text: " That didn't work." });
  assert.deepEqual(w.rows.map((r: any) => [r.kind, r.text]), [["bb", "Handing you over. That didn't work."]]);
});

test("Walk: the transcript is capped, oldest first", () => {
  const w = T.createWalkTranscript({ max: 3 });
  w.start();
  for (const n of [1, 2, 3, 4]) w.transcript({ speaker: n % 2 ? "you" : "assistant", text: `t${n}` });
  assert.deepEqual(w.rows.map((r: any) => r.text), ["t2", "t3", "t4"]);
});

test("Notebook turns: a thread is named by the turn, else by its id, else 'Thread'", () => {
  const titleOf = (id: string) => (id === "thr_known" ? "Known title" : null);
  assert.deepEqual(T.turnSpeaker({ speaker: "you" }), { kind: "you", name: "You", threadId: null });
  assert.deepEqual(T.turnSpeaker({ speaker: "bb" }), { kind: "bb", name: "BB", threadId: null });
  assert.deepEqual(T.turnSpeaker({ speaker: "thread", threadId: "thr_x1", title: "Invoices" }), { kind: "thread", name: "Invoices", threadId: "thr_x1" });
  assert.deepEqual(T.turnSpeaker({ speaker: "thread", threadId: "thr_x1", threadTitle: "Invoices" }).name, "Invoices");
  assert.deepEqual(T.turnSpeaker({ speaker: "thread", thread: { id: "thr_x2", title: "Nested" } }), { kind: "thread", name: "Nested", threadId: "thr_x2" });
  assert.deepEqual(T.turnSpeaker({ speaker: "thread", threadId: "thr_known" }, { titleOf }), { kind: "thread", name: "Known title", threadId: "thr_known" });
  assert.deepEqual(T.turnSpeaker({ speaker: "thread" }, { titleOf }), { kind: "thread", name: "Thread", threadId: null });
  assert.equal(T.turnSpeaker({ speaker: "thread", threadId: "javascript:alert(1)", title: "X" }).threadId, null, "only real thread ids link");
});

test("Conversations: newest first, grouped by day; tags and durations", () => {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const groups = T.groupByDay([
    { id: "a", startedAt: "2026-09-27T09:00:00.000Z" },
    { id: "b", startedAt: "2026-09-28T15:00:00.000Z" },
    { id: "c", startedAt: "2026-09-28T08:00:00.000Z" },
  ], day);
  assert.deepEqual(groups.map((g: any) => [g.label, g.sessions.map((s: any) => s.id)]), [["2026-09-28", ["b", "c"]], ["2026-09-27", ["a"]]]);
  assert.deepEqual(["walk", "hey-bb", "check-in", "panel", "other"].map(T.surfaceTag), ["Walk", "Hey BB", "Check-in", "Desk", "Desk"]);
  assert.deepEqual([12, 59, 60, 290, 3600, 3900].map(T.duration), ["12 s", "59 s", "1 min", "5 min", "1 h", "1 h 5 min"]);
});

test("GET /app puts talk.js inline, and the page's scripts compile", async () => {
  const routes = new Map<string, (c: any) => Promise<Response> | Response>();
  const bb: any = {
    pluginId: "pocket",
    log: { info: () => {}, warn: () => {}, error: () => {} },
    settings: { define: () => ({ get: async () => ({ notifications: false, recommendations: false, gmailDrafts: false }) }) },
    storage: { kv: { get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] } },
    rpc: { register: () => {} },
    http: { route: (method: string, path: string, fn: any) => routes.set(`${method} ${path}`, fn) },
    background: { service: () => undefined },
    sdk: { threads: { list: async () => [] } },
  };
  await plugin(bb);
  const raw = readFileSync(new URL("../page.html", import.meta.url), "utf8");
  assert.equal(raw.split(TALK_TAG).length, 2, "page.html loads talk.js once");
  const html = await (await routes.get("GET /app")!({})).text();
  assert.ok(!html.includes(TALK_TAG));
  assert.ok(html.includes("root.PocketTalk ="));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2);
  for (const code of scripts) new Script(code); // throws on a syntax error
  assert.match(html, /#\/conversations/);
});

// Created: 2026-10-04. After a walk: the threads each conversation started, nested, with where each stands.
test("a conversation's started threads come out flat, in order, with depth and state", () => {
  const rows = T.startedRows([
    { threadId: "thr_a", title: "🎙 Draft notes", state: "needs-you", unread: true, via: "started", children: [
      { threadId: "thr_a1", title: "Its helper", state: "working", unread: false, children: [] }] },
    { threadId: "thr_mgr", title: "bb manager", state: "done", unread: false, via: "asked", children: [
      { threadId: "thr_m1", title: "🎙 Voice work", state: "done", unread: true, children: [] }] },
    { threadId: "not-an-id", title: "dropped", state: "done", children: [] },
  ]);
  assert.deepEqual(rows.map((r: any) => [r.threadId, r.depth, r.state]), [
    ["thr_a", 0, "Needs you · unread"], ["thr_a1", 1, "Working"],
    ["thr_mgr", 0, "You asked this thread · Done"], ["thr_m1", 1, "Done · unread"]]);
  assert.equal(rows[0].needsYou, true);
  assert.deepEqual(T.startedRows(null), [], "an older Talk to BB sends no threads");
});
