// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A scroll must never change a number an admin typed (owner, 2026-10-24).
 *
 * The owner typed 105 into the USDT team-pool price, scrolled down the long
 * Settings page to reach Save, and saved 104.98. A browser's `<input
 * type="number">` takes the mouse wheel as a value change while it has focus,
 * so two notches of scroll past a field with `step=0.01` took ₹0.02 off a
 * price that values every pool purchase — silently, with the number the person
 * typed still in their head and the wrong one in the box. Typing it again did
 * the same thing, which is why it looked like the platform refusing the value.
 *
 * So a wheel over a focused number field takes the focus off it and scrolls the
 * page instead. The event is NOT swallowed: the page still scrolls, which is
 * what the person was doing. Keyboard arrows are left alone — those are a
 * deliberate press on the field in hand.
 *
 * One listener for the whole panel rather than a prop on each input: a guard
 * every screen has to remember is a guard the next screen forgets, and this
 * one is about money.
 */

/** True for a field the wheel would change: a focused number input that is not read-only. */
export function wheelWouldChange(target: EventTarget | null): target is HTMLInputElement {
  const el = target as HTMLInputElement | null;
  return !!el && el instanceof HTMLInputElement && el.type === 'number'
    && el === el.ownerDocument?.activeElement && !el.readOnly && !el.disabled;
}

/** Install the guard. Returns the function that removes it. */
export function installNumberInputGuard(doc: Document = document): () => void {
  const onWheel = (event: Event) => {
    if (!wheelWouldChange(event.target)) return;
    // Blur, so the browser applies the wheel to the page and not to the value.
    (event.target as HTMLInputElement).blur();
  };
  // Capture, so it runs before the input's own handling of the event.
  doc.addEventListener('wheel', onWheel, { capture: true, passive: true });
  return () => doc.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
}
