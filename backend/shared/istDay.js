// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A calendar day an admin picked for a report filter: `YYYY-MM-DD`, read as an
 * IST day by the query that uses it, or null when unset. Anything else is a
 * 400 the panel can phrase (§32 S35), never a date silently read as another.
 *
 * In SQL, a day `$n` covers
 *   col >= ($n::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
 *   col <  ($n::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
 * so a "to" day is included whole.
 */
export function istDay(v, name = 'date') {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw Object.assign(new Error(`${name} must be a date (YYYY-MM-DD).`), { status: 400, code: 'BAD_DATE' });
  }
  return s;
}
