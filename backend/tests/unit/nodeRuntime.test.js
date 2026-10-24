// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** The boot check for Node's October 2026 security release (owner, 2026-10-24). */
import { describe, it, expect, vi } from 'vitest';
import { MIN_NODE, nodeIsPatched, warnIfNodeUnpatched } from '../../startup/nodeRuntime.js';

describe('nodeIsPatched', () => {
  it('knows the fixed 22.x and anything newer', () => {
    expect(MIN_NODE).toBe('22.23.4');
    expect(nodeIsPatched('v22.23.4')).toBe(true);
    expect(nodeIsPatched('v22.23.10')).toBe(true);
    expect(nodeIsPatched('v22.24.0')).toBe(true);
    expect(nodeIsPatched('v24.22.1')).toBe(true);
  });
  it('flags every older one, compared as numbers not text', () => {
    expect(nodeIsPatched('v22.23.3')).toBe(false);
    expect(nodeIsPatched('v22.22.0')).toBe(false);
    expect(nodeIsPatched('v22.9.99')).toBe(false);
    expect(nodeIsPatched('v20.19.0')).toBe(false);
  });
});

describe('warnIfNodeUnpatched', () => {
  it('logs and alerts on an old Node, and stays quiet on a patched one', () => {
    const log = vi.fn(); const alert = vi.fn(() => Promise.resolve());
    expect(warnIfNodeUnpatched({ version: 'v22.22.0', log, alert })).toBe(true);
    expect(log.mock.calls[0][0]).toMatch(/v22\.22\.0 is older than 22\.23\.4/);
    expect(alert).toHaveBeenCalledWith('node-runtime-unpatched', expect.any(String), { version: 'v22.22.0', minimum: '22.23.4' });
    const quiet = vi.fn();
    expect(warnIfNodeUnpatched({ version: 'v22.23.4', log: quiet, alert: quiet })).toBe(false);
    expect(quiet).not.toHaveBeenCalled();
  });
  it('never throws, whatever the alert channel does', () => {
    expect(() => warnIfNodeUnpatched({ version: 'v22.1.0', log: () => { throw new Error('x'); }, alert: () => { throw new Error('y'); } })).not.toThrow();
  });
});
