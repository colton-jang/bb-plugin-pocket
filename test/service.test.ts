// The notify service end to end against a fake bb: which threads notify, and
// that nothing notifies twice. Everything runs in dry run, so the log lines
// are what would be sent. Run: npm test
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import plugin from "../server.ts";

const T = 1_800_000_000_000;
const MIN = 60_000;

type Row = { kind: "conversation"; role: "user" | "assistant"; text: string; createdAt: number };
type Thread = {
  id: string; projectId: string; status: string; title: string; updatedAt: number;
  latestAttentionAt: number; lastReadAt: number | null; parentThreadId?: string | null; pinnedAt?: number | null;
  hasPendingInteraction?: boolean; runtime?: { displayStatus: string } | null;
};

function world() {
  const threads: Thread[] = [];
  const timelines = new Map<string, Row[]>();
  const interactions = new Map<string, Array<{ id: string; status: string; createdAt: number; payload: Record<string, unknown> }>>();
  const kv = new Map<string, unknown>();
  const logs: string[] = [];
  const services = new Map<string, { start: (signal: AbortSignal) => Promise<void> }>();
  const rpc: Record<string, (input: any) => Promise<any>> = {};
  const settings: Record<string, unknown> = { notifications: true, notificationsDryRun: true, recommendations: false, managerSkill: "" };
  const calls = { timeline: 0, interactions: 0 };
  const bb: any = {
    pluginId: "pocket",
    log: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`WARN ${m}`), error: (m: string) => logs.push(`ERR ${m}`) },
    settings: { define: () => ({ get: async () => settings }) },
    storage: {
      kv: {
        get: async (k: string) => (kv.has(k) ? structuredClone(kv.get(k)) : undefined),
        set: async (k: string, v: unknown) => { kv.set(k, structuredClone(v)); },
        delete: async (k: string) => { kv.delete(k); },
        list: async (prefix: string) => [...kv.keys()].filter((k) => k.startsWith(prefix)),
      },
    },
    rpc: { register: (_c: unknown, handlers: typeof rpc) => Object.assign(rpc, handlers) },
    http: { route: () => undefined },
    background: { service: (name: string, def: { start: (signal: AbortSignal) => Promise<void> }) => services.set(name, def) },
    sdk: {
      threads: {
        list: async ({ archived }: { archived?: boolean }) => (archived ? [] : structuredClone(threads)),
        timeline: async ({ threadId }: { threadId: string }) => { calls.timeline++; return { rows: timelines.get(threadId) ?? [] }; },
        interactions: { list: async ({ threadId }: { threadId: string }) => { calls.interactions++; return interactions.get(threadId) ?? []; } },
      },
    },
  };
  const add = (t: Partial<Thread> & { id: string }, agent?: { text: string; at: number }) => {
    threads.push({ projectId: "proj_x", status: "idle", title: t.id, updatedAt: agent?.at ?? T, latestAttentionAt: agent?.at ?? T, lastReadAt: null, ...t });
    if (agent) timelines.set(t.id, [{ kind: "conversation", role: "user", text: "Do the thing", createdAt: agent.at - MIN }, { kind: "conversation", role: "assistant", text: agent.text, createdAt: agent.at }]);
  };
  return { bb, threads, timelines, interactions, kv, logs, services, rpc, settings, calls, add };
}

const settle = async () => { for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r)); };
const sent = (logs: string[]) => logs.filter((l) => l.startsWith("notify (dry run"));
const payloadOf = (line: string) => JSON.parse(line.slice(line.indexOf(": {") + 2));

test("notify service: what notifies, what doesn't, and never twice", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T });
  t.after(() => mock.timers.reset());
  const w = world();
  await plugin(w.bb);
  await w.rpc.registerDevice({ token: "ab".repeat(32), env: "sandbox", bundleId: "com.example.pocket" });
  await w.rpc.registerDevice({ token: "AB".repeat(32), env: "sandbox", bundleId: "com.example.pocket" }); // same token, any case
  assert.equal((w.kv.get("devices") as unknown[]).length, 1);

  // Replied a minute ago, unread, idle: a reply with Yes / Not now (no OpenAI key: the yes/no fallback).
  w.add({ id: "thr_reply" }, { text: "Built the **deck**. Should I go ahead and publish the site?", at: T - MIN });
  // A command waiting for approval.
  w.add({ id: "thr_approve", hasPendingInteraction: true, status: "waiting" });
  w.interactions.set("thr_approve", [{ id: "int_a", status: "pending", createdAt: T - 30_000, payload: { kind: "approval", reason: null, subject: { kind: "command", command: "npm run deploy" } } }]);
  // A question with four options.
  w.add({ id: "thr_question", hasPendingInteraction: true, status: "waiting" });
  w.interactions.set("thr_question", [{ id: "int_q", status: "pending", createdAt: T - 20_000, payload: { kind: "user_question", questions: [{ id: "q1", prompt: "Which client?", options: ["A", "B", "C", "D"].map((x) => ({ label: `Client ${x}`, value: x })) }] } }]);
  // Never: a hidden child, a message older than the cutoff, a dismissed thread, one still working, one you've read.
  w.add({ id: "thr_child", parentThreadId: "thr_reply" }, { text: "child done", at: T - MIN });
  w.add({ id: "thr_old" }, { text: "old news", at: T - 2 * 3600_000 });
  w.add({ id: "thr_dismissed" }, { text: "dismissed", at: T - MIN });
  w.kv.set("dismissed:thr_dismissed", T - MIN);
  w.add({ id: "thr_working", runtime: { displayStatus: "running" } }, { text: "still going", at: T - MIN });
  w.add({ id: "thr_read", lastReadAt: T - 5_000 }, { text: "seen it", at: T - 10 * MIN });

  const ac = new AbortController();
  const running = w.services.get("notify")!.start(ac.signal);
  mock.timers.tick(5_000);
  await settle();

  const first = sent(w.logs);
  const byThread = new Map(first.map((l) => [l.match(/\) (thr_\w+)/)![1], payloadOf(l)]));
  assert.deepEqual([...byThread.keys()].sort(), ["thr_approve", "thr_question", "thr_reply"]);
  assert.ok(first.every((l) => l.includes("→ 1 device(s)")));
  assert.ok(first[0].includes("no APNs key"));
  const reply = byThread.get("thr_reply");
  assert.equal(reply.aps.category, "POCKET_REPLY");
  assert.equal(reply.aps.alert.title, "thr_reply");
  assert.equal(reply.pocket.forAt, T - MIN);
  assert.deepEqual(reply.pocket.choices.map((c: { label: string }) => c.label), ["Yes, go ahead", "Not now"]);
  assert.equal(byThread.get("thr_approve").pocket.interactionId, "int_a");
  assert.match(byThread.get("thr_approve").aps.alert.body, /^Run a command: npm run deploy/);
  assert.deepEqual(byThread.get("thr_question").pocket.choices.map((c: { text: string }) => c.text), ["A", "B", "C"]);
  // The pills were cached where the page's `suggest` reads them.
  assert.equal((w.kv.get("sug4:thr_reply") as { forAt: number }).forAt, T - MIN);

  // Next poll: nothing new, nothing re-sent, and unchanged threads cost no timeline reads.
  const reads = w.calls.timeline;
  mock.timers.tick(20_000);
  await settle();
  assert.equal(sent(w.logs).length, 3);
  assert.equal(w.calls.timeline, reads);

  // A stale recommendation for the message already notified: not again.
  w.kv.set("rec:thr_reply", { forAt: T - MIN, attn: T - MIN, pills: [{ label: "Go", text: "Go ahead." }], recommended: 0, reason: "r", stake: "s" });
  // One for the thread you'd read: it's in Needs you now, so it notifies, recommendation first.
  w.kv.set("rec:thr_read", { forAt: T - 10 * MIN, attn: T - 10 * MIN, pills: [{ label: "Alt", text: "Alt." }, { label: "Pick", text: "Pick this." }], recommended: 1, reason: "because", stake: "Whether to ship today" });
  mock.timers.tick(20_000);
  await settle();
  const recLines = sent(w.logs).slice(3);
  assert.equal(recLines.length, 1);
  const rec = payloadOf(recLines[0]);
  assert.equal(rec.pocket.threadId, "thr_read");
  assert.equal(rec.aps.alert.body, "Whether to ship today");
  assert.deepEqual(rec.pocket.choices.map((c: { label: string }) => c.label), ["Pick", "Alt"]);
  assert.equal(rec.pocket.recommended, 0);

  // The agent answers again in thr_reply: a new message, a new notification.
  w.timelines.get("thr_reply")!.push({ kind: "conversation", role: "assistant", text: "Also fixed the footer.", createdAt: T + 50_000 });
  Object.assign(w.threads.find((x) => x.id === "thr_reply")!, { latestAttentionAt: T + 50_000, updatedAt: T + 50_000 });
  mock.timers.tick(20_000);
  await settle();
  const again = sent(w.logs).slice(4);
  assert.equal(again.length, 1);
  assert.equal(payloadOf(again[0]).pocket.forAt, T + 50_000);

  ac.abort();
  await running;
});

test("notify service: at most 6 a minute; the rest wait, then go", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T });
  t.after(() => mock.timers.reset());
  const w = world();
  await plugin(w.bb);
  for (let i = 0; i < 8; i++) w.add({ id: `thr_many${"abcdefgh"[i]}` }, { text: `Message ${i}`, at: T - (i + 1) * 1000 });
  const ac = new AbortController();
  const running = w.services.get("notify")!.start(ac.signal);
  mock.timers.tick(5_000);
  await settle();
  assert.equal(sent(w.logs).length, 6);
  // Newest first: the two oldest wait.
  assert.ok(!sent(w.logs).some((l) => l.includes("thr_manyg") || l.includes("thr_manyh")));
  mock.timers.tick(20_000);
  await settle();
  assert.equal(sent(w.logs).length, 6);
  mock.timers.tick(20_000);
  await settle();
  mock.timers.tick(20_000);
  await settle();
  assert.equal(sent(w.logs).length, 8);
  ac.abort();
  await running;
});

test("notify service: off means silent, and turning it on doesn't replay the backlog", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T });
  t.after(() => mock.timers.reset());
  const w = world();
  w.settings.notifications = false;
  await plugin(w.bb);
  w.add({ id: "thr_early" }, { text: "Earlier message", at: T - MIN });
  const ac = new AbortController();
  const running = w.services.get("notify")!.start(ac.signal);
  mock.timers.tick(5_000);
  await settle();
  assert.equal(sent(w.logs).length, 0);
  // Two hours later it's switched on: the old message is backlog.
  mock.timers.tick(2 * 3600_000);
  w.settings.notifications = true;
  mock.timers.tick(20_000);
  await settle();
  assert.equal(sent(w.logs).length, 0);
  ac.abort();
  await running;
});

test("testNotification: dry run reports each device", async () => {
  const w = world();
  await plugin(w.bb);
  await w.rpc.registerDevice({ token: "cd".repeat(32), env: "production", bundleId: "com.example.pocket" });
  const r = await w.rpc.testNotification({ threadId: "thr_target" });
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.results, [{ device: "…cdcdcd", env: "production", status: 0, reason: "dry run" }]);
  // The test never names a thread (the old one pointed at the manager, and its
  // buttons could have sent there): no thread, no category, no buttons.
  const p = payloadOf(sent(w.logs)[0]);
  assert.equal(p.pocket.threadId, undefined);
  assert.equal(p.aps.category, undefined);
  assert.equal(JSON.parse(r.payload).pocket.kind, "test");
});

test("Notifications screen: a kind you turn off is never sent; quiet hours go silent", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T });
  t.after(() => mock.timers.reset());
  const w = world();
  await plugin(w.bb);
  // Replies off; quiet hours around the clock (00:00-23:59 UTC) so this poll is quiet.
  await w.rpc.setNotifyPrefs({ kinds: { approval: true, question: true, reply: false }, quiet: { on: true, start: "00:00", end: "23:59", tz: "UTC" } });
  const st = await w.rpc.notifyStatus(null);
  assert.equal(st.prefs.kinds.reply, false);
  assert.equal(st.quietNow, true);
  w.add({ id: "thr_replyoff" }, { text: "Done, over to you", at: T - 1000 });
  w.add({ id: "thr_asks", hasPendingInteraction: true, status: "waiting" });
  w.interactions.set("thr_asks", [{ id: "int_1", status: "pending", createdAt: T - 500, payload: { kind: "approval", reason: null, subject: { kind: "command", command: "ls" } } }]);
  const ac = new AbortController();
  const running = w.services.get("notify")!.start(ac.signal);
  mock.timers.tick(5_000);
  await settle();
  const lines = sent(w.logs);
  assert.ok(!lines.some((l) => l.includes("thr_replyoff")), "replies are off: nothing sent");
  assert.ok(w.logs.some((l) => l.includes("thr_replyoff reply: off in your settings")));
  const approval = lines.find((l) => l.includes("thr_asks"));
  assert.ok(approval, "approvals still on");
  assert.match(approval!, /quiet hours/);
  assert.equal(payloadOf(approval!).aps["interruption-level"], "passive");
  // And it isn't retried once quiet hours or settings change: handled means handled.
  await w.rpc.setNotifyPrefs({ kinds: { approval: true, question: true, reply: true }, quiet: { on: false, start: "22:00", end: "07:00", tz: "UTC" } });
  mock.timers.tick(20_000);
  await settle();
  assert.equal(sent(w.logs).length, lines.length);
  ac.abort();
  await running;
});

test("Notifications screen: devices are listed by token tail and can be forgotten", async () => {
  const w = world();
  await plugin(w.bb);
  await w.rpc.registerDevice({ token: "ab".repeat(32), env: "sandbox", bundleId: "com.example.pocket" });
  await w.rpc.registerDevice({ token: "cd".repeat(32), env: "production", bundleId: "com.example.pocket" });
  let st = await w.rpc.notifyStatus(null);
  assert.deepEqual(st.devices.map((d: any) => d.id), ["ababab", "cdcdcd"]);
  assert.equal(st.dryRun, true);
  assert.equal(st.keyReady, false);
  await w.rpc.forgetDevice({ id: "ababab" });
  st = await w.rpc.notifyStatus(null);
  assert.deepEqual(st.devices.map((d: any) => d.id), ["cdcdcd"]);
  await assert.rejects(() => w.rpc.forgetDevice({ id: "ffffff" }));
});
