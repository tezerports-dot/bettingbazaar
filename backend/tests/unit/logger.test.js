// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
  /**
   * A logger loaded with the env this test is ABOUT, not the env it happens to
   * run in.
   *
   * `THRESHOLD` in services/logger.js is a module-load `const` reading
   * `LOG_LEVEL` first, so a test that flips `NODE_ENV` after importing the
   * module has already missed its chance — and a developer (or a CI job) with
   * `LOG_LEVEL=warn` exported suppressed every `info` call, so both info tests
   * saw an EMPTY spy and failed with "Cannot read properties of undefined".
   *
   * That reads exactly like the redaction guard being broken. It was not: the
   * logger was fine and the suite was measuring the ambient environment. The
   * `error()` test below kept passing throughout, because error passes a `warn`
   * threshold — which is what made the failure look selective and real.
   *
   * So the level is pinned here and the module re-imported under it.
   *
   * `runWithContext` comes back from the SAME fresh graph, and it has to:
   * `vi.resetModules()` gives the re-imported logger a new `requestContext`
   * module with its own AsyncLocalStorage, so the top-level `runWithContext`
   * imported by this file would be writing into a different store than the one
   * the logger reads — and `reqId` would come back undefined with everything
   * else correct, which is the most confusing way for this to fail.
   */
  const freshLogger = async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'debug';
    const [{ logger }, ctx] = await Promise.all([
      import('../../services/logger.js'),
      import('../../middleware/requestContext.js'),
    ]);
    return { logger, runWithContext: ctx.runWithContext };
  };

  it('carries the correlation id into the record (prod JSON mode)', async () => {
    const prev = process.env.NODE_ENV;
    const prevLevel = process.env.LOG_LEVEL;
    const { logger, runWithContext: run } = await freshLogger();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      run('corr-9', () => logger.info('deposit credited', { orderId: 'o1' }));
      const line = spy.mock.calls.at(-1)[0];
      const rec = JSON.parse(line);
      expect(rec).toMatchObject({ level: 'info', msg: 'deposit credited', reqId: 'corr-9', orderId: 'o1' });
      expect(rec.ts).toBeTruthy();
    } finally {
      process.env.NODE_ENV = prev;
      if (prevLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prevLevel;
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

  it('REDACTS sensitive keys before they reach the log sink (AQ-13)', async () => {
    const prev = process.env.NODE_ENV;
    const prevLevel = process.env.LOG_LEVEL;
    const { logger } = await freshLogger();
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
      if (prevLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prevLevel;
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
