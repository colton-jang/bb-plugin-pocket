# bb Pocket

A radically simpler phone view of [bb](https://getbb.app). The full bb web app is the desktop app squeezed onto a phone.
Pocket keeps only what a phone is for: giving your agents instructions, triaging what needs you, and glancing at what
got made.

Pocket is a bb plugin. It serves its own full-screen page from your bb server, so there's no separate app, hosting,
or login: if you can open bb, you can open Pocket.

## What's in it

- **Home:** Pinned, Needs you, Working, Earlier.
  - **Swipe left:** mark read/unread. Keep going to **dismiss** it from Needs you until the agent says something new.
  - **Swipe right:** pin (bb's own pins, so they match desktop).
  - **Opening a thread is a peek** and leaves it unread; marking read is always your call.
  - **Long press** a row for Rename, Pin, Mark read/unread, Dismiss, **Make manager**, Open in full bb.
  - **Rename** opens with an AI-suggested short title already filled in. ✨ Again asks for another, Undo puts the
    old title back, and a suggestion never overwrites text you've started typing.
  - **Search** (top of home): thread titles and message text across all threads, archived included, plus artifact
    names.
  - **Machines:** a line under search shows which of your bb machines are online. A machine that says it's
    connected but hasn't checked in for 5 minutes (a sleeping laptop) counts as offline.
- **Voice:** hold the big mic to talk. Release to finish, slide up to lock for a long note, slide left to cancel.
  - You see the transcript before it sends.
  - It goes to your *manager* thread or any thread you pick. The manager is picked automatically (see settings), or
    long press any thread → *Make manager*. The manager row carries a mic tag.
- **Threads:** your messages and the agent's final answer per turn, with no tool-call noise.
  - Answer the agent's questions with one tap, allow or deny steps, reply by typing or voice.
  - **Attach files** with the paperclip (photos, camera, or any file; also on New thread). Big photos are shrunk to
    2048 px before upload. Files go to the thread's project like a desktop attachment, and show under your message.
  - **Thread mentions** (`@thread:thr_…`, or a bare thread id) show as chips with the thread's title. Tap one to
    open that thread.
  - **File links** in messages open: images full-screen (pinch to zoom), `.md` files in Pocket's reader, pages and
    PDFs in a new tab through bb's preview. Relative paths resolve in the thread's folder; missing files say so.
  - **Model chip:** while you type, a chip above the reply box shows the thread's model. Tap it to switch model,
    reasoning level, or access (Auto / Full access) for the next turn. bb takes access per message, so Pocket
    remembers your choice for that thread and sends it with every message you send from Pocket.
  - **New thread:** pick the project, machine and model.
  - **Swipe in from the right edge** (or tap the tray icon in the header) for the files and links the thread
    produced. The thread's ⋯ menu also has Rename.
- **Quick replies:** up to four suggested replies as pills. Tap: "Sending… tap to cancel" for 2 s, then it sends.
  Hold: puts the text in the reply box, with Undo.
- **Stale threads get an opinion.** When you leave an agent's message unanswered (30 min after you saw it, or 2 h
  unseen), a stronger model writes one line on what's at stake and picks one recommended reply with a reason. It shows
  in the thread and on the home row.
- **Artifacts:** every Google Doc/Sheet/Slides, PDF, page or site your agents linked, newest first. Tap to open;
  files open through a short-lived bb preview.
- **Siri, Action Button & share sheet:** an iOS Shortcut dictates with Apple's own dictation and sends to your
  manager thread after a 3-second countdown. Setup is inside Pocket (home screen → *Talk to bb from Siri…*).
- **Walk** (optional): a hands-free live voice session, if you also have the Talk to BB plugin installed.
  iPhone stops a web page's microphone when the phone locks, so Walk keeps the screen on. Tap **Lock** for a dim
  screen that ignores pocket touches and shows what BB is doing; hold the button at the bottom to unlock.
- **Drafts** (optional): a reminder list of unsent Gmail and Slack drafts, if you configure a source.

**Safety rails:**
- A pill can never tell an agent to send, post, forward, email, delete or archive anything. That's filtered on the
  server, not just asked of the model.
- One-tap sends always have a cancel window.
- Pocket has no send button for email or Slack.

## Install

You need bb 0.43 or newer. To use it from your phone, you also need bb Connect (`https://<your-handle>.getbb.app`).

```bash
# straight from git
bb plugin install git:https://github.com/ChaningJang/bb-plugin-pocket.git

# from a folder (an unzipped release or a git clone)
bb plugin install /path/to/bb-plugin-pocket

# or from a marketplace that lists it
bb plugin install pocket@<marketplace>
```

## Set up (two minutes)

1. **Add your OpenAI API key.** Open bb → Settings → Plugins → Pocket and paste it into *OpenAI API key*. It's stored
   as a secret on your bb server and never sent to the browser.
   - Pocket works without a key: voice falls back to bb's own transcription, quick replies fall back to a simple
     yes/no, and stale-thread recommendations are off.
   - With a key, it costs pennies a day. Transcription runs per note; suggestions run once per agent message (cached).
2. **Optionally, in the same settings:**
   - *Your first name*: used in the prompts that suggest replies for you.
   - *Names to spell right*: comma-separated clients, teammates and tools, so voice notes get them right.
   - *Manager skill name*: the home mic sends to the most recent top-level thread that started with `/<skill>` or
     loaded that skill (default `bb-manager`). If you don't use one, Pocket asks where to send.
   - Models: defaults are `gpt-4o-transcribe`, `gpt-5.6-luna` for pills, and `gpt-6-sol` for recommendations.
3. **Open it on your phone:** `https://<your-handle>.getbb.app/api/v1/plugins/pocket/http/app`
   - On iPhone: Share → **Add to Home Screen**, and it opens full-screen like an app.
   - The first tap on the mic after opening turns the mic on. Safari asks for permission once per load.

### Optional extras

- **Walk:** install the Talk to BB plugin (same install steps as Pocket) and give it
  an OpenAI key with GPT-Live access. Pocket shows the Walk button when it's running.
- **Drafts:**
  - Gmail: turn on *Drafts: list Gmail drafts*. This needs the `gws` CLI signed in on the bb server; set its path
    and any environment it needs.
  - Slack: Slack won't list drafts, so point *Slack draft log* at a JSONL file your tools append to, with
    `{ts, channel, target, thread, text, draft_id}` per line. Add an env file with `SLACK_USER_TOKEN` so sent drafts
    drop off.
- **Extra artifacts:** *Artifacts: extra JSONL ledger*, one `{ts, target, label}` per line, for things declared on
  purpose. Links that agents mention are picked up either way.

## What leaves your server

With an OpenAI key set, Pocket sends to OpenAI:
- **Voice notes:** the audio.
- **Quick replies and recommendations:** the agent's latest message and your previous message in that thread.

Nothing else leaves your server, and nothing is sent to anyone else.

## Known limits (iOS web apps)

- **No haptics on press-and-hold.** Apple blocks web haptics except real taps on switches, so the mic uses soft sound
  cues instead.
- **Recording pauses your music, and it won't resume by itself.** Safari can't duck other audio or hand it back.
- **Safari asks for the microphone once per page load.**

## How it's built

- `server.ts`: plugin RPC over `bb.sdk`, a background job for stale-thread recommendations, and HTTP routes for the
  page, the manifest, the icon and `/open` (artifact redirects).
- `page.html`: the whole UI in one file, with no build step. Edits show on the next page load.
- All state lives in the plugin's own storage: pins and read state are bb's; seen, dismissed, cached suggestions and
  the tap log are Pocket's.

```bash
npm install && npx tsc -p .     # typecheck
bb plugin reload pocket         # after server.ts changes
```

## Contributing

Source: [ChaningJang/bb-plugin-pocket](https://github.com/ChaningJang/bb-plugin-pocket), MIT licensed. Issues and pull
requests are welcome. Releases are `vX.Y.Z` tags and a tag is never moved; a fix ships as a new version.
