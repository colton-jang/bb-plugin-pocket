// Created: 2026-09-28. Voice conversations in Pocket, as plain functions the
// page and the tests share (server.ts inlines this file into the page, so it
// stays a classic script: no imports, no exports, one global).
//
// Two jobs:
// - The Walk transcript: one running record across a direct thread line
//   (manager → thread → manager) and a reconnect. Earlier turns are never
//   dropped when a leg starts or ends, and each turn says who spoke: "BB" for
//   the manager, the thread's title for a thread.
// - The Conversations screen: Talk to BB's notebook (Walk, Hey BB, check-ins
//   and the desk panel) grouped by day, with the same speaker names.
(function (root) {
  const SURFACE_TAGS = { walk: "Walk", "hey-bb": "Hey BB", "check-in": "Check-in", panel: "Desk" };
  const surfaceTag = (surface) => SURFACE_TAGS[surface] || "Desk";

  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const THREAD_ID = /^thr_[a-z0-9]+$/;
  const threadIdOf = (v) => (typeof v === "string" && THREAD_ID.test(v) ? v : null);

  /**
   * Who said a notebook turn. The notebook marks a thread's voice as speaker
   * "thread"; its identity may come on the turn as threadId + title (or
   * threadTitle / name, or a nested thread object). A missing title is looked
   * up by id (the page passes its thread list), else it reads "Thread".
   */
  function turnSpeaker(turn, { titleOf = () => null } = {}) {
    const s = turn?.speaker;
    if (s === "you" || s === "user") return { kind: "you", name: "You", threadId: null };
    if (s !== "thread" && s !== "worker") return { kind: "bb", name: "BB", threadId: null };
    const threadId = threadIdOf(turn.threadId) || threadIdOf(turn.thread?.id);
    const name = str(turn.label) || str(turn.title) || str(turn.threadTitle) || str(turn.name) || str(turn.thread?.title)
      || (threadId ? str(titleOf(threadId)) : null) || "Thread";
    return { kind: "thread", name, threadId };
  }

  /** Newest first, grouped under a day label ("Today", "Yesterday", …). */
  function groupByDay(sessions, dayLabel) {
    const sorted = [...(sessions || [])].sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0));
    const groups = [];
    for (const s of sorted) {
      const label = dayLabel(Date.parse(s.startedAt || 0) || 0);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.sessions.push(s); else groups.push({ label, sessions: [s] });
    }
    return groups;
  }

  /** "45 s", "4 min", "1 h 5 min". */
  function duration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
  }

  /**
   * The live Walk transcript. Feed it the voice socket's `transcript` and
   * `leg` events. The thread's voice starts at leg {mode:"worker"} and ends at
   * leg {mode:"manager"}; in between ("switching") the voice that's still on
   * the line keeps its name, so BB's "handing you over" line stays BB's.
   */
  function createWalkTranscript({ max = 300 } = {}) {
    let rows = [];
    let voice = { kind: "bb", name: "BB", threadId: null };
    const push = (row) => { rows.push(row); if (rows.length > max) rows.splice(0, rows.length - max); };
    const divider = (text) => push({ kind: "switch", name: "", threadId: null, text });
    return {
      get rows() { return rows; },
      get voice() { return voice; },
      /** A new Walk clears the record; a continued one (reconnect) keeps it. */
      start({ continued = false } = {}) {
        voice = { kind: "bb", name: "BB", threadId: null };
        if (!continued) rows = [];
        else if (rows.length && rows[rows.length - 1].kind !== "switch") divider("Reconnected");
      },
      transcript({ speaker, text } = {}) {
        if (typeof text !== "string" || !text) return;
        const who = speaker === "you" ? { kind: "you", name: "You", threadId: null } : voice;
        const last = rows[rows.length - 1];
        if (last && last.kind === who.kind && last.threadId === who.threadId) last.text += text;
        else push({ ...who, text });
      },
      /** Returns the status line for the leg change, or null. */
      leg(e = {}) {
        const title = str(e.target?.title) || "the thread";
        const threadId = threadIdOf(e.target?.threadId);
        if (e.mode === "switching") return e.to === "worker" ? `Handing you to ${title}…` : "Taking you back to BB…";
        if (e.mode === "worker") {
          voice = { kind: "thread", name: str(e.target?.title) || "Thread", threadId };
          divider(`Talking to ${voice.name}`);
          return `Talking directly to ${title}. Say "take me back to the manager" to return.`;
        }
        if (e.mode === "manager") {
          const wasThread = voice.kind === "thread";
          voice = { kind: "bb", name: "BB", threadId: null };
          if (wasThread) { divider("Back with BB"); return "Back with BB."; }
          return e.from === "worker" ? `Couldn't open a line to ${title}. Still with BB.` : null;
        }
        return null;
      },
    };
  }

  root.PocketTalk = { SURFACE_TAGS, surfaceTag, turnSpeaker, groupByDay, duration, createWalkTranscript };
})(globalThis);
