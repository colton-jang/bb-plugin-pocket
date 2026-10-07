// Dictated messages carry one marker line; slash commands and already-marked
// text pass through unchanged. Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { DICTATED_HEADER, markDictated } from "../dictation.ts";

test("dictated text gets the marker line once", () => {
  const once = markDictated("start a thread on the Q4 plan");
  assert.equal(once, `${DICTATED_HEADER}\nstart a thread on the Q4 plan`);
  assert.equal(markDictated(once), once);
});

test("slash commands and empty text are left alone", () => {
  assert.equal(markDictated("/bb-manager"), "/bb-manager");
  assert.equal(markDictated("  "), "  ");
});
