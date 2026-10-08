// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * controlEvidence.mjs — what KIND of evidence each drive verdict is (§35).
 *
 * Two reports read `drive.report*.json`: `report:controls` (what the default
 * accounts' presses did to the default inventory) and `report:control-gaps`
 * (what each account is shown that the default is not, and — since the drive
 * can press as a profile — what pressing it as THAT account did). Both have to
 * turn a verdict into a §35 kind, and a second copy of this table would drift
 * the way §5 says copies do: a verdict added to one and not the other is a
 * control one report counts and the other silently drops. So it lives here
 * once, and a verdict no kind claims comes back as `UNCLASSIFIED` rather than
 * vanishing (§35.2).
 *
 * ── What KIND of evidence each verdict is ─────────────────────────────────
 *
 * These are not five ways of saying "covered". They are five different
 * claims, and adding them together produces a number that means nothing —
 * which is the trap this grouping exists to stop. Reclassifying an `alert()`
 * from NEEDS_INPUT to SAID is a correct reading of what happened; it is NOT
 * equivalent to proving a state change. A button correctly disabled is
 * correct behaviour; it is NOT the feature behind it being tested.
 *
 * So the reports keep them apart and refuse to publish one headline
 * percentage. The goal is not 100% of anything. The goal is:
 *
 *   every meaningful behaviour has an appropriate test, or a stated reason
 *   why it cannot or should not have one.
 *
 * A category with a large number in it is a question, not an achievement:
 * REPRESENTED at 574 asks "is the first instance really representative?",
 * and STATE at 0 on a screen full of actions asks why nothing was asserted.
 *
 * MUTATION is not here, on purpose: the drive reads the SCREEN and cannot tell
 * a rendered change from a committed one. Only `test:mutate`, which reads the
 * database back and checks a bystander, can claim it (§35.1).
 */
export const KIND = {
  // The strongest evidence this pass can produce on its own: the press moved
  // the screen. It is still WEAKER than a mutation case, which reads the
  // database back — `drive.report.json` cannot tell a rendered change from a
  // committed one, and does not claim to.
  SCREEN_MOVED: { verdicts: ['ACTED'], says: 'pressed, and the routed region changed' },
  // It called its route and the answer came back — a working read.
  ANSWERED: {
    verdicts: ['REFETCHED', 'UPSTREAM'],
    says: 'pressed; it called a route and the server answered, including a refusal that names what to fix',
  },
  // It told the person something. An outcome, not a state change.
  SAID: {
    verdicts: ['SAID'],
    says: 'pressed; the panel answered with an alert() — informational, and NOT evidence of a mutation',
  },
  // Nothing should have happened, and nothing did.
  NO_OP_BY_DESIGN: {
    verdicts: ['ALREADY_ON'],
    says: 'pressed; it was already the selected segment, so no change is the correct outcome',
  },
  // Nothing happened and nothing was called. Triage, and the shape worth hunting.
  INERT: {
    verdicts: ['INERT'],
    says: 'pressed; changed nothing AND called nothing — §32 S22 candidate, read the list',
  },
  // Correct state. Whether the ENABLE transition is covered is a separate
  // question, answered by the mutating pass, and a disabled control here is
  // not a claim that the feature behind it works.
  DISABLED: {
    verdicts: ['DISABLED'],
    says: 'disabled on arrival — correct state; the enable transition is a SEPARATE test',
  },
  // ── Two DIFFERENT claims, kept apart ─────────────────────────────────
  // Both mean "not pressed here", and that is where the similarity ends.
  //
  // REPEAT is an ASSUMPTION: the first instance of this name on this screen
  // stood in for it. That is usually fair (fifty rows, fifty identical
  // Delete buttons) and it is not free — row 40's button carries row 40's id,
  // and the assumption is exactly what hides a per-row defect. A large number
  // here is a question about the assumption, never a coverage figure.
  REPEAT: {
    verdicts: ['REPRESENTED', 'DUPLICATE'],
    says: 'a repeat of a name already pressed on this screen — covered ONLY IF the first instance is representative',
  },
  // DRIVEN_ELSEWHERE is a CHECKABLE claim: the mutating pass has a case for
  // it, and `npm run test:mutate` prints whether that case drove. A deferral
  // whose case does not exist is not covered, it is unpressed with a reason.
  DRIVEN_ELSEWHERE: {
    verdicts: ['DEFERRED'],
    says: 'destructive — driven by `npm run test:mutate` against its own rows; check THAT output, this is a pointer not a proof',
  },
  // Asked a question this pass will not answer blind.
  ASKED: {
    verdicts: ['NEEDS_INPUT'],
    says: 'it asked a confirm/prompt and this pass declines — answered in the mutating pass instead',
  },
  // The honest gap.
  // ── A control the press REMOVES from every other screen ──────────────
  // "Dismiss announcement" is one banner shown above all sixteen player
  // screens. The inventory is taken AT REST and sees it on every one; the
  // drive presses it on the first screen, the dismissal sticks, and it is
  // legitimately absent from the other fourteen.
  //
  // Counting those fourteen as NOT REACHED overstates the gap by 14 and
  // describes a control that was pressed twice and ACTED both times. This is
  // the mirror of `revealed` — a screen that SHRINKS when you press it — and
  // it is only claimed when the SAME kind and name ACTED elsewhere in this
  // panel in this run, which is evidence rather than an excuse.
  PRESSED_ON_ANOTHER_SCREEN: {
    verdicts: [],
    says: 'absent because an earlier press removed it platform-wide — the same control ACTED on another screen this run',
  },
  NOT_REACHED: {
    verdicts: ['GONE', 'UNREACHABLE', 'THROTTLED'],
    says: 'NOT pressed and not by choice — this is the number that is left',
  },
  BROKE: { verdicts: ['THREW', 'FIVE_HUNDRED'], says: 'threw, or the server answered 5xx with nothing to act on' },
};

/** verdict → kind, derived so a new verdict cannot be silently uncounted. */
export const KIND_OF = new Map();
for (const [kind, spec] of Object.entries(KIND)) {
  for (const v of spec.verdicts) KIND_OF.set(v, kind);
}
export const UNCLASSIFIED = 'UNCLASSIFIED';
export const kindOf = (verdict) => KIND_OF.get(verdict) ?? UNCLASSIFIED;

/**
 * Kinds that mean the drive did NOT press the control: it was disabled, it was
 * deferred to a mutating case (a pointer, kept apart by the callers), or the
 * pass could not reach it. Everything else is a press of some kind — including
 * BROKE, which is a press that found a defect.
 */
export const NOT_A_PRESS = new Set(['DISABLED', 'DRIVEN_ELSEWHERE', 'NOT_REACHED']);
