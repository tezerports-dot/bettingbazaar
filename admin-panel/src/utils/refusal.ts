// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A refusal in the server's own words (§32 S14, S48): the `message` the route
 * phrased, else the caller's fallback. One reader, so no screen invents its own
 * wording for an answer the server already gave.
 */
export function refusalText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { message?: unknown } }; message?: unknown } | null;
  const said = e?.response?.data?.message;
  if (typeof said === 'string' && said.trim()) return said;
  return fallback;
}
