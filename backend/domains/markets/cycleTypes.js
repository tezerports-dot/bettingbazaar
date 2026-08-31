// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/markets/cycleTypes.js — the cycle-type vocabulary, in one place.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * A cycle type is not one fact, it is six: the enum value the model accepts,
 * the label shown to humans, which `SystemConfig.cyclePhases` key holds its
 * timings, which `SystemConfig.betLimits` key holds its stake bounds, the
 * prefix its `cycleId` is built from, and how long its block runs.
 *
 * Before this module those six were spread across the model's enum, two
 * ternaries in the generator (`type === '30_MIN' ? '30-MIN' : 'FULL-DAY'`),
 * another in `bet.routes.js` (`isFullDay ? 'fullDay' : 'thirtyMin'`), and two
 * near-identical `ensureActive*Cycle` methods. Adding `1_MIN` to that shape
 * would have been six edits in five files, and the ternaries fail SILENTLY
 * when they miss one: a new type would have been labelled "FULL-DAY" in every
 * result announcement and would have inherited the 30-minute stake limits
 * without anyone writing a line saying so.
 *
 * So the vocabulary is declared once and read everywhere. `phasesFor` and
 * `limitsKeyFor` throw on an unknown type rather than defaulting, because a
 * silent default is exactly how the old ternaries would have gone wrong.
 *
 * ── What this module does NOT own ──────────────────────────────────────────
 * The phase timings and stake limits themselves. Those are Business Policy
 * (`SystemConfig.cyclePhases` / `.betLimits`, §1) and admin-editable at
 * runtime; this module only names which key belongs to which type.
 */

/** Enum values, exactly as stored in `Cycle.type`. */
export const CYCLE_TYPES = Object.freeze({
  ONE_MIN:    '1_MIN',
  THIRTY_MIN: '30_MIN',
  FULL_DAY:   'FULL_DAY',
});

/**
 * Per-type metadata.
 *
 * `interval` marks the types whose blocks TILE THE HOUR — their start time is
 * `floor(minute / duration) * duration`, so the same creation path serves them
 * all. FULL_DAY is anchored to a calendar date instead and keeps its own path;
 * that is a genuine difference in kind, not duplication worth collapsing.
 */
const META = Object.freeze({
  [CYCLE_TYPES.ONE_MIN]: Object.freeze({
    label: '1-MIN',
    phasesKey: 'oneMin',
    limitsKey: 'oneMin',
    idPrefix: '1MIN',
    interval: true,
    // Fixed, unlike the 30-minute block's admin-tunable duration. The phase
    // offsets (12/9/5/3s before end) leave 48s of open betting in a 60s block;
    // a shorter duration would put the merge before the cycle started, and the
    // ordering invariant could not catch that because it only checks the
    // phases against each other.
    fixedDurationMin: 1,
    newCycleMessage: 'New 1-minute cycle started!',
    mergeMessage: 'Pools merging...',
    closeMessage: 'Bets closed! Calculating winner...',
  }),
  [CYCLE_TYPES.THIRTY_MIN]: Object.freeze({
    label: '30-MIN',
    phasesKey: 'thirtyMin',
    limitsKey: 'thirtyMin',
    idPrefix: '30MIN',
    interval: true,
    // null = read SystemConfig.cycleDurationMinutes (admin-tunable, must divide
    // 60 evenly). The '30_MIN' label does not change when that value does.
    fixedDurationMin: null,
    newCycleMessage: 'New 30-minute cycle started!',
    mergeMessage: 'Pools merging...',
    closeMessage: 'Bets closed! Calculating winner...',
  }),
  [CYCLE_TYPES.FULL_DAY]: Object.freeze({
    label: 'FULL-DAY',
    phasesKey: 'fullDay',
    limitsKey: 'fullDay',
    idPrefix: 'FULLDAY',
    interval: false,
    fixedDurationMin: null,
    newCycleMessage: 'New full-day cycle started!',
    mergeMessage: 'Daily pools merging...',
    closeMessage: 'Daily bets closed! Calculating winner...',
  }),
});

/** Every valid `Cycle.type`, in display order (shortest block first). */
export const CYCLE_TYPE_VALUES = Object.freeze(Object.keys(META));

/** The hour-tiling types, which share one creation path. */
export const INTERVAL_CYCLE_TYPES = Object.freeze(
  CYCLE_TYPE_VALUES.filter((t) => META[t].interval),
);

/** True for a value that is a known cycle type. */
export function isCycleType(type) {
  return Object.prototype.hasOwnProperty.call(META, type);
}

/**
 * Metadata for a type.
 * @throws if the type is unknown — see the header: silence is the failure mode.
 */
export function cycleMeta(type) {
  const meta = META[type];
  if (!meta) throw new Error(`Unknown cycle type '${type}'`);
  return meta;
}

/** Human label used in result announcements and logs, e.g. '1-MIN'. */
export function cycleLabel(type) {
  return cycleMeta(type).label;
}

/**
 * The type's phase offsets, resolved from an already-loaded `cyclePhases`
 * config object (the generator caches it for 30s and passes it in).
 */
export function phasesFor(type, allPhases) {
  return allPhases?.[cycleMeta(type).phasesKey];
}

/** Which `SystemConfig.betLimits` key holds this type's stake bounds. */
export function limitsKeyFor(type) {
  return cycleMeta(type).limitsKey;
}
