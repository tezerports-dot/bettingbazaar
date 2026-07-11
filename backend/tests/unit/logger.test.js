// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the X-6 correlation-id context + structured logger (pure,
// no DB). AsyncLocalStorage works in-process, so the correlation threading
// is fully testable without a request.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runWithContext, getRequestId, setContextUser, getContextUser } from '../../middleware/requestContext.js';
import { logger } from '../../services/logger.js';

afterEach(() => vi.restoreAllMocks());

describe('request context (correlation id)', () => {
  it('exposes the id only inside the context', () => {
    expect(getRequestId()).toBeUndefined(); // outside any request
    runWithContext('abc-123', () => {
      expect(getRequestId()).toBe('abc-123');
      setContextUser('user-1');
      expect(getContextUser()).toBe('user-1');
    });
    expect(getRequestId()).toBeUndefined(); // leaves no global state
  });

  it('isolates concurrent contexts', async () => {
    const seen = [];
    await Promise.all([
      runWithContext('req-A', async () => { await Promise.resolve(); seen.push(getRequestId()); }),
      runWithContext('req-B', async () => { await Promise.resolve(); seen.push(getRequestId()); }),
    ]);
    expect(seen.sort()).toEqual(['req-A', 'req-B']); // no cross-talk
  });
});

describe('structured logger', () => {
  it('carries the correlation id into the record (prod JSON mode)', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      runWithContext('corr-9', () => logger.info('deposit credited', { orderId: 'o1' }));
      const line = spy.mock.calls.at(-1)[0];
      const rec = JSON.parse(line);
      expect(rec).toMatchObject({ level: 'info', msg: 'deposit credited', reqId: 'corr-9', orderId: 'o1' });
      expect(rec.ts).toBeTruthy();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('routes error() to console.error as JSON in prod mode', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      runWithContext('err-7', () => logger.error('settlement failed', { code: 'E_X' }));
      const rec = JSON.parse(spy.mock.calls.at(-1)[0]);
      expect(rec).toMatchObject({ level: 'error', msg: 'settlement failed', reqId: 'err-7', code: 'E_X' });
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
