// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The base modal every other modal is built on.
 *
 * ── Why the base one is worth testing on its own ────────────────────────────
 * Five modals wrap this, including the two that move money. Anything wrong here
 * is wrong five times, and the failures are the quiet kind: a close button that
 * does not close leaves a player stuck on a dialog; a backdrop that swallows
 * clicks meant for the content makes a form unusable; a body scroll-lock that
 * is never released leaves the whole page frozen after the modal is gone.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from './Modal';

describe('Modal', () => {
  it('renders its children', () => {
    render(<Modal onClose={() => {}}>an important message</Modal>);
    expect(screen.getByText('an important message')).toBeInTheDocument();
  });

  it('shows a title and a close button when given a title', () => {
    render(<Modal onClose={() => {}} title="Withdraw">body</Modal>);
    expect(screen.getByText('Withdraw')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('renders NO header when the title is absent or empty', () => {
    // The header is what carries the close button, so a modal without a title
    // can only be dismissed by the backdrop. That is a deliberate shape for a
    // blocking dialog, and it must not appear by accident.
    for (const title of [undefined, '', null as unknown as undefined]) {
      render(<Modal onClose={() => {}} title={title}>body</Modal>);
      expect(screen.queryByRole('button')).toBeNull();
      cleanup();
    }
  });

  it('closes when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} title="Withdraw">body</Modal>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    const { container } = render(<Modal onClose={onClose}>body</Modal>);
    const backdrop = container.querySelector('.absolute.inset-0');
    expect(backdrop, 'the backdrop must exist to be clickable').toBeTruthy();
    await userEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT close when the content is clicked', async () => {
    // The backdrop sits behind the content. If a click on a form field bubbled
    // to it, every attempt to type would dismiss the dialog.
    const onClose = vi.fn();
    render(<Modal onClose={onClose}><button type="button">Confirm</button></Modal>);
    await userEvent.click(screen.getByText('Confirm'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('locks body scroll while open and RELEASES it on unmount', () => {
    const { unmount } = render(<Modal onClose={() => {}}>body</Modal>);
    expect(document.body.style.overflow).toBe('hidden');
    // The release is the half that breaks: a modal that locks and never unlocks
    // leaves the page unscrollable after it is gone, and nothing on screen
    // explains why.
    unmount();
    expect(document.body.style.overflow).toBe('unset');
  });

  it('releases the scroll lock even when several modals stack', () => {
    const first = render(<Modal onClose={() => {}}>one</Modal>);
    const second = render(<Modal onClose={() => {}}>two</Modal>);
    expect(document.body.style.overflow).toBe('hidden');
    second.unmount();
    first.unmount();
    expect(document.body.style.overflow).toBe('unset');
  });
});
