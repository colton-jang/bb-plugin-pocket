# Pocket notifications

Pocket can push notifications to the Pocket iOS app through Apple Push (APNs), so you can answer an agent from the
lock screen. The server side lives in this plugin: `notify.ts` (the rules, the payload, the APNs token) and the
`notify` background service in `server.ts`.

## When it notifies

The service polls every 20 seconds. It reads the thread list bb already has and only looks inside a thread (its
timeline or its pending interactions) when that thread's attention or update time has changed. A thread only counts
if it's on Pocket's home: a top-level thread, or a child that's pinned or waiting on a question. Archived threads,
threads you dismissed (Pocket's long swipe), and other child threads never notify.

| Kind | When | Title / body | Choices |
|---|---|---|---|
| `approval` | A permission request is pending, and you haven't read the thread since it arrived | Thread title / "Run a command: npm test" | None. The app offers Allow / Deny. |
| `question` | An agent question is pending, and you haven't read the thread since it arrived | Thread title / the first question's prompt | The options (up to 3), when it's one single-select question |
| `reply` | The agent finished, it spoke last, and the thread is unread | Thread title / the start of its last message (140 characters, plain text) | Up to 3 of Pocket's quick-reply pills for that message. A stale-thread recommendation, if one exists for that message, comes first as `recommended: 0`. |
| `reply` (recommendation) | Pocket's stale-thread sweep recommended a reply to a message that hasn't been notified yet | Thread title / the recommendation's "what's at stake" line | The recommendation first (`recommended: 0`), then its alternatives |

The rules:

- **One notification per agent message.** A message (`forAt`) is never notified twice, and a recommendation for a
  message that was already notified doesn't notify again. Each interaction notifies once, by its id.
- **Nothing old when it starts.** Anything from more than 30 minutes before notifications were switched on, or before
  the plugin last started, is skipped.
- **At most 6 a minute.** The newest go first, and the rest wait for the next poll.
- **Pills are safe.** Every choice passes the same filter as the quick-reply pills: none tells an agent to send, post,
  forward, email, delete or archive anything.
- **Pills are shared.** A reply's pills come from the same cache the page uses (`suggest`), so the notification and
  the thread show the same pills from a single model call.

## Payload

```json
{
  "aps": {
    "alert": { "title": "…", "body": "…" },
    "sound": "default",
    "thread-id": "thr_…",
    "category": "POCKET_REPLY | POCKET_APPROVAL | POCKET_QUESTION",
    "mutable-content": 1
  },
  "pocket": {
    "threadId": "thr_…",
    "kind": "reply | approval | question",
    "forAt": 1790000000000,
    "interactionId": "…",
    "questionId": "…",
    "choices": [{ "label": "…", "text": "…" }],
    "recommended": 0
  }
}
```

- `interactionId` is set for `approval` and `question`.
- `questionId` is set for a single-question `question`. `allowFreeText` (questions only) says whether bb accepts a typed
  answer: if true, Reply… answers with `freeText`; if false, Reply… sends the text as a normal message instead.
- `choices` has at most 3 entries and is left out when there are none.
- `recommended` is an index into `choices`. It's only set when a stale-thread recommendation picked one.

Every notification is sent with these headers: `apns-push-type: alert`, `apns-topic: <the device's bundle id>`,
`apns-collapse-id: <threadId>` (so a newer notification for the same thread replaces the older one), and
`apns-priority: 10`.

## Answering from a notification

The app calls Pocket's ordinary RPCs at `POST /api/v1/plugins/pocket/rpc/<method>`. The JSON body is the input, and the
response is `{ "ok": true, "result": … }`.

| Action | Call |
|---|---|
| Register the device (on every launch) | `registerDevice {token: "<hex>", env: "sandbox" \| "production", bundleId}` → `{ok: true}` |
| Tap a reply choice, or type a reply | `send {threadId, text}` (for a choice, `text` is `choices[i].text`) |
| Allow / Allow for session / Deny | `approve {threadId, interactionId, decision: "allow_once" \| "allow_for_session" \| "deny"}` |
| Pick a question's choice | `answer {threadId, interactionId, answers: {[questionId]: {selected: [choices[i].text]}}}` |
| Mark read | `setRead {threadId, read: true}` |
| Dismiss from Needs you | `dismiss {threadId}` |

`approve` and `answer` fail if someone already answered the interaction somewhere else. In that case, show that it was
already handled.

## Settings

| Setting | Default | |
|---|---|---|
| `notifications` | `false` | Master switch for the service. |
| `notificationsDryRun` | `true` | Logs what would be sent (body cut short) instead of sending. It also applies automatically whenever the key file, key id or team id is missing. |
| `apnsKeyFile` | | Path to the `.p8` key on the bb server. |
| `apnsKeyId` | | The key's 10-character Key ID. |
| `apnsTeamId` | | Your Apple Developer Team ID. |
| `apnsBundleId` | | Optional. When set, only devices registered with this bundle id are notified. |

The provider token (an ES256 JWT) is signed with node's `crypto` and reused for 40 minutes. Sends go over HTTP/2 to
`api.sandbox.push.apple.com` or `api.push.apple.com`, depending on the `env` the device registered with. A `410`, or
`BadDeviceToken`, drops that device. Each send is logged with the thread id, kind, the last characters of the device
token, and APNs's status, never the message text.

## Going live

1. Create a key at developer.apple.com → Certificates, Identifiers & Profiles → Keys → **+**. Tick **Apple Push
   Notifications service (APNs)**, then download the `.p8` file. Apple lets you download it only once. Note the Key ID,
   and your Team ID (shown under Membership).
2. Put the `.p8` on the bb server, readable only by you, for example `chmod 600 ~/.config/pocket/AuthKey_XXXXXXXXXX.p8`.
3. Configure the plugin:
   ```bash
   bb plugin config pocket set apnsKeyFile ~/.config/pocket/AuthKey_XXXXXXXXXX.p8
   bb plugin config pocket set apnsKeyId XXXXXXXXXX
   bb plugin config pocket set apnsTeamId YYYYYYYYYY
   bb plugin config pocket set apnsBundleId <the app's bundle id>   # optional
   bb plugin config pocket set notifications true
   bb plugin config pocket set notificationsDryRun false
   ```
4. Open the app once so it registers, then send yourself a test notification:
   `bb plugin rpc call pocket testNotification`. It points at your manager thread. To use a different thread, pass
   `--input-file` with `{"threadId": "thr_…"}`. The result shows APNs's answer for each device: `200` means Apple
   accepted it.

## Your settings (Notifications screen, since v0.4.16)
- Home → **Notifications →** (`#/notifications`): status (Off / Practice mode / On), per-kind switches (Approvals,
  Questions, Your turn), quiet hours in your time zone, the registered phones (forget one), and a test.
- Stored in plugin kv `notifyPrefs`. A kind that's off is marked handled and never sent. In quiet hours notifications
  still go out, but silently: `aps["interruption-level"] = "passive"` and no `sound`; they land in Notification Center
  without waking the screen, and everything still waits in Needs you.
- RPCs: `notifyStatus` (null → status, prefs, devices by last 6 token characters), `setNotifyPrefs`, `forgetDevice {id}`.
- **Test notification** (`testNotification`, also the screen's button): no thread, no category, no buttons
  (`pocket.kind = "test"`), collapse id `pocket-test`. It can't act on any thread; `threadId` input is ignored.
  In dry run it only logs and returns the payload it would send.

