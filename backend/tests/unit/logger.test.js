// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the X-6 correlation-id context + structured logger (pure,
// no DB). AsyncLocalStorage works in-process, so the correlation threading
// is fully testable without a request.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runWithContext, getRequestId, setContextUser, getContextUser } from '../../middleware/requestContext.js';
import { logger, redact } from '../../services/logger.js';

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

  it('REDACTS sensitive keys before they reach the log sink (AQ-13)', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logger.info('login attempt', {
        mobile: '9990001111',
        password: 'hunter2',
        body: { otp: '123456', token: 'ey.jwt.tok', note: 'ok' },
        authorization: 'Bearer secret',
      });
      const rec = JSON.parse(spy.mock.calls.at(-1)[0]);
      expect(rec.password).toBe('[REDACTED]');
      expect(rec.authorization).toBe('[REDACTED]');
      expect(rec.body.otp).toBe('[REDACTED]');
      expect(rec.body.token).toBe('[REDACTED]');
      // Non-sensitive fields are preserved.
      expect(rec.mobile).toBe('9990001111');
      expect(rec.body.note).toBe('ok');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe('redact()', () => {
  it('masks nested and array-nested secrets, keeps depth bounded', () => {
    const out = redact({ a: { jwt: 'x', list: [{ secret: 's', keep: 1 }] }, keep: 2 });
    expect(out.a.jwt).toBe('[REDACTED]');
    expect(out.a.list[0].secret).toBe('[REDACTED]');
    expect(out.a.list[0].keep).toBe(1);
    expect(out.keep).toBe(2);
  });

  it('serializes Error objects to readable fields instead of masking', () => {
    const out = redact({ err: new Error('boom') });
    expect(out.err.message).toBe('boom');
    expect(out.err.name).toBe('Error');
  });
});
