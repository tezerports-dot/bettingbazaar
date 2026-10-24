// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The scroll that changed a saved price (owner, 2026-10-24): 105 typed into the
 * USDT team-pool price was saved as 104.98, two wheel notches of a 0.01 step.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { installNumberInputGuard, wheelWouldChange } from './numberInputGuard';

const numberInput = (step = '0.01') => {
  const el = document.createElement('input');
  el.type = 'number';
  el.step = step;
  el.value = '105';
  document.body.append(el);
  return el;
};

describe('a wheel over a number field', () => {
  afterEach(() => { document.body.replaceChildren(); });

  it('takes the focus off a focused number field, so the page scrolls instead of the value changing', () => {
    const remove = installNumberInputGuard();
    const el = numberInput();
    el.focus();
    expect(wheelWouldChange(el)).toBe(true);

    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));

    expect(document.activeElement).not.toBe(el);
    expect(el.value).toBe('105');
    remove();
  });

  it('leaves a field nobody is typing in alone, so nothing else about the page changes', () => {
    const remove = installNumberInputGuard();
    const el = numberInput();
    expect(wheelWouldChange(el)).toBe(false);
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    expect(el.value).toBe('105');
    remove();
  });

  it('leaves text fields and read-only numbers alone', () => {
    const text = document.createElement('input');
    text.type = 'text';
    document.body.append(text);
    text.focus();
    expect(wheelWouldChange(text)).toBe(false);

    const readOnly = numberInput();
    readOnly.readOnly = true;
    readOnly.focus();
    expect(wheelWouldChange(readOnly)).toBe(false);
  });

  it('is gone once removed', () => {
    const remove = installNumberInputGuard();
    remove();
    const el = numberInput();
    el.focus();
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    expect(document.activeElement).toBe(el);
  });
});
