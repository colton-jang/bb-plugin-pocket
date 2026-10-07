// Dictated text sent to a thread starts with one marker line, so the agent
// reading it (a manager, say) knows the request came by voice. A slash
// command is left alone: a line in front of it would stop it being one.
export const DICTATED_HEADER = "\u{1F399} Dictated via Pocket:";

export function markDictated(text: string): string {
  const body = text.trim();
  if (!body || body.startsWith("/") || body.startsWith(DICTATED_HEADER)) return text;
  return `${DICTATED_HEADER}\n${body}`;
}
