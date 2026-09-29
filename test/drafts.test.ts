// Drafts stay up to date: a Gmail draft sent or deleted anywhere drops off,
// and Slack drafts drop once sent (even edited), when a newer draft replaces
// them, and after a few days. Gmail is a fake gws script; Slack is a fake fetch.
// Run: npm test
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import plugin from "../server.ts";

const dir = mkdtempSync(join(tmpdir(), "pocket-drafts-"));
const gmailState = join(dir, "gmail.json");
const fakeGws = join(dir, "gws");
// Answers drafts list / drafts get / getProfile from gmail.json; a missing draft is a 404.
writeFileSync(fakeGws, `#!/usr/bin/env node
const fs = require("fs");
const drafts = JSON.parse(fs.readFileSync(${JSON.stringify(gmailState)}, "utf8"));
const args = process.argv.slice(2), p = JSON.parse(args[args.indexOf("--params") + 1]);
if (args[2] === "getProfile") { console.log(JSON.stringify({ emailAddress: "me@example.com" })); process.exit(0); }
if (args[3] === "list") { console.log(JSON.stringify({ drafts: drafts.map((d) => ({ id: d.id, message: { id: d.hex, threadId: d.thread } })) })); process.exit(0); }
const d = drafts.find((x) => x.id === p.id);
if (!d) { console.error("error[api]: Requested entity was not found."); process.exit(1); }
console.log(JSON.stringify({ message: { internalDate: String(d.at), snippet: d.subject, payload: { headers: [{ name: "To", value: "Pat <pat@example.com>" }, { name: "Subject", value: d.subject }] } } }));
`);
chmodSync(fakeGws, 0o755);
const setGmail = (ds: Array<{ id: string; hex: string; thread: string; subject: string; at: number }>) => writeFileSync(gmailState, JSON.stringify(ds));

const slackLog = join(dir, "slack-drafts.jsonl");
const slackEnv = join(dir, "slack.env");
writeFileSync(slackEnv, "SLACK_USER_TOKEN=xoxp-test\n");

function world() {
  const kv = new Map<string, unknown>();
  const rpc: Record<string, (input: any) => Promise<any>> = {};
  const settings = { notifications: false, recommendations: false, gmailDrafts: true, gwsPath: fakeGws, gwsEnv: "", slackDraftsLog: slackLog, slackEnvFile: slackEnv };
  const bb: any = {
    pluginId: "pocket",
    log: { info: () => {}, warn: () => {}, error: () => {} },
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
    background: { service: () => undefined },
    sdk: { threads: { list: async () => [] } },
  };
  return { bb, kv, rpc };
}

test("Gmail: a draft sent or deleted elsewhere drops off on the next fresh load", async () => {
  const now = Date.now();
  setGmail([
    { id: "r-1", hex: "a1", thread: "a1", subject: "New note", at: now - 60_000 },
    { id: "r-2", hex: "b2", thread: "t9", subject: "Re: plan", at: now - 120_000 },
  ]);
  const w = world();
  await plugin(w.bb);
  const first = await w.rpc.drafts({ fresh: true });
  assert.deepEqual(first.gmail.map((g: any) => [g.id, g.threadId]), [["r-1", "a1"], ["r-2", "t9"]]);
  assert.equal(first.account, "me@example.com");
  assert.equal(first.gmailLink, "app");

  setGmail([{ id: "r-2", hex: "b2", thread: "t9", subject: "Re: plan", at: now - 120_000 }]);
  assert.equal((await w.rpc.drafts({})).gmail.length, 2, "within a minute, the cached list");
  assert.deepEqual((await w.rpc.drafts({ fresh: true })).gmail.map((g: any) => g.id), ["r-2"]);
  await assert.rejects(w.rpc.draftBody({ id: "r-1" }), /not found/);
});

test("Gmail: the phone link you pick sticks", async () => {
  setGmail([]);
  const w = world();
  await plugin(w.bb);
  await w.rpc.setGmailLink({ style: "cv0" });
  assert.equal((await w.rpc.drafts({})).gmailLink, "cv0");
});

test("Slack: sent (even edited), replaced, removed, or aged out drafts drop off", async (t) => {
  setGmail([]);
  const now = Date.now() / 1000;
  const row = (id: string, channel: string, text: string, agoH: number, thread: string | null = null) =>
    JSON.stringify({ ts: now - agoH * 3600, draft_id: id, channel, target: channel, thread, text });
  writeFileSync(slackLog, [
    row("D_old", "C1", "Four days old and never sent", 96),
    row("D_first", "C2", "First try at the reply about the budget", 5),
    row("D_second", "C2", "Second try at the reply about the budget", 4),
    row("D_edit", "C3", "All yours! Tuesday is totally fine, it's your relationship with Ashish.", 3),
    row("D_other", "C4", "All 3 done: emoji are up and Quest is reinstalled", 2),
    row("D_exact", "C5", "Found it! Your PR only has the case study", 1, "1700000000.000100"),
    row("D_keep", "C6", "Hold the invoice until the MSA is signed", 1),
    row("D_parent", "C7", "Same words as the thread's first message", 0.5, "1700000000.000200"),
  ].join("\n") + "\n");
  const history: Record<string, Array<{ user: string; text: string; ts: string }>> = {
    C3: [{ user: "U_ME", text: "100% up to you. Your relationship, so I'm happy for you to send it Tuesday", ts: String(now - 2 * 3600) }],
    C4: [{ user: "U_ME", text: "on it", ts: String(now - 3600) }], // a different message: the draft is still there
    C5: [
      { user: "U_ME", text: "Found it! Your PR only has the case study", ts: "1700000000.000100" }, // the thread's first message, from before
      { user: "U_ME", text: "Found it! Your PR only has the case study, plus the kit", ts: String(now - 1800) },
    ],
    C6: [{ user: "U_THEM", text: "Hold the invoice until the MSA is signed", ts: String(now - 1800) }],
    C7: [{ user: "U_ME", text: "Same words as the thread's first message", ts: "1700000000.000200" }], // from before the draft
  };
  mock.method(globalThis, "fetch", async (url: string) => {
    const u = new URL(url);
    const body = u.pathname.endsWith("auth.test") ? { ok: true, user_id: "U_ME", team_id: "T1" } : { ok: true, messages: history[u.searchParams.get("channel")!] ?? [] };
    return new Response(JSON.stringify(body));
  });
  t.after(() => mock.restoreAll());
  const w = world();
  await plugin(w.bb);
  const keys = async (fresh = true) => (await w.rpc.drafts({ fresh })).slack.map((s: any) => s.key);
  assert.deepEqual(await keys(), ["D_parent", "D_keep", "D_other", "D_second"]);
  assert.deepEqual(w.kv.get("slackSent"), ["D_exact", "D_edit"]);

  await w.rpc.dismissDraft({ key: "D_other" });
  assert.deepEqual(await keys(false), ["D_parent", "D_keep", "D_second"]);
});
