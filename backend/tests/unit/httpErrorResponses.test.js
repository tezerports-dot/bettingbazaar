// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * `shared/httpError.js` is what 30 converted handlers now route their failures
 * through (F-008, F-013), so its branching is pinned here rather than inferred
 * from the fact that those handlers' own tests still pass.
 *
 * The branch that matters is the one a route test cannot easily provoke: an
 * UNEXPECTED fault, where the whole point is that the caller learns nothing.
 * A route test asserts a refusal's wording — the case that was already correct.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { serverError, callerError, respondError } from '../../shared/httpError.js';

/** Just enough of an express response to record what was sent. */
function res() {
  const sent = { status: null, body: null };
  return {
    sent,
    status(code) { sent.status = code; return this; },
    json(payload) { sent.body = payload; return this; },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('an unexpected fault tells the caller nothing and the operator everything', () => {
  it('answers 500 with a generic message and never the error text', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = res();
    // The shape that actually shows up: a Postgres error. It carries a SQLSTATE
    // in `code` and a constraint name in `message`, and NO `status` — which is
    // exactly what makes it distinguishable from a refusal somebody wrote.
    const pgErr = Object.assign(
      new Error('null value in column "merchant_id" violates not-null constraint'),
      { code: '23502', constraint: 'order_states_merchant_id_not_null' },
    );

    respondError(r, pgErr, 'POST /payment/deposit/create');

    expect(r.sent.status).toBe(500);
    expect(r.sent.body.message).not.toMatch(/merchant_id|constraint|null value/);
    // The SQLSTATE is a schema fact too, and `callerError` spreads `code` — so
    // the fault branch must not be reached with it.
    expect(r.sent.body).not.toHaveProperty('code');
    expect(log).toHaveBeenCalledOnce();
    // The half of F-008 that was worse than the disclosure: the operator was
    // told nothing either. Both the label and the real text must be logged.
    const logged = log.mock.calls[0].join(' ');
    expect(logged).toContain('POST /payment/deposit/create');
    expect(logged).toMatch(/merchant_id/);
  });

  it('does not populate passthrough fields on the fault branch', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = res();
    // A fault that happens to carry a same-named property still must not have
    // it forwarded: the panel branches on these, and a value it was never meant
    // to see is worse than an absent key.
    const err = Object.assign(new Error('boom'), { balance: 999999 });

    respondError(r, err, 'POST /payment/withdrawal/create', { passthrough: ['balance'] });

    expect(r.sent.status).toBe(500);
    expect(r.sent.body).not.toHaveProperty('balance');
  });
});

describe('a refusal somebody wrote keeps its wording', () => {
  it('passes the status, code and message through untouched', () => {
    const r = res();
    const refusal = Object.assign(new Error('This UTR was already used'), {
      status: 409, code: 'DUPLICATE_UTR',
    });

    respondError(r, refusal, 'POST /payment/order/:orderId/mark-paid');

    expect(r.sent.status).toBe(409);
    expect(r.sent.body).toMatchObject({
      success: false, code: 'DUPLICATE_UTR', message: 'This UTR was already used',
    });
  });

  it('a DELIBERATE 5xx is still a refusal — presence of status decides, not its value', () => {
    // USDT_RATE_UNSET, "Funding provider is not active", "RAG retrieval not
    // configured": all real 503s in this codebase whose wording IS the feature.
    // Routing on `status >= 500` instead of on its presence would swallow every
    // one of them and answer "Something went wrong", which §25 forbids — a
    // refusal names that rail's own reason.
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = res();
    const refusal = Object.assign(new Error('USDT buy rate is not configured.'), {
      status: 503, code: 'USDT_RATE_UNSET',
    });

    respondError(r, refusal, 'POST /payment/usdt/deposit/create');

    expect(r.sent.status).toBe(503);
    expect(r.sent.body.code).toBe('USDT_RATE_UNSET');
    expect(r.sent.body.message).toMatch(/rate is not configured/);
    expect(log).not.toHaveBeenCalled();
  });

  it('carries the named extra fields, and only those, and only when set', () => {
    const r = res();
    const refusal = Object.assign(new Error('Withdrawals are closed for today'), {
      status: 409, cutoffPassed: true, balance: '250000', secretInternalHint: 'do-not-send',
    });

    respondError(r, refusal, 'POST /payment/withdrawal/create', {
      passthrough: ['cutoffPassed', 'balance', 'originalOrderId'],
    });

    expect(r.sent.body.cutoffPassed).toBe(true);
    expect(r.sent.body.balance).toBe('250000');
    // Named but unset: absent, not `undefined`. A panel doing `'x' in body` or
    // rendering `body.x ?? …` gets a different answer from the two.
    expect(r.sent.body).not.toHaveProperty('originalOrderId');
    // Not named: never forwarded, whatever the error happens to carry.
    expect(r.sent.body).not.toHaveProperty('secretInternalHint');
  });

  it('`false` and `0` are values, not absences', () => {
    // The guard is `!== undefined` rather than truthiness on purpose:
    // `cutoffPassed: false` is the answer "no, you are still inside the window".
    const r = res();
    const refusal = Object.assign(new Error('nope'), { status: 400, cutoffPassed: false, balance: 0 });

    respondError(r, refusal, 'x', { passthrough: ['cutoffPassed', 'balance'] });

    expect(r.sent.body.cutoffPassed).toBe(false);
    expect(r.sent.body.balance).toBe(0);
  });
});

describe('the two named functions keep their own contracts', () => {
  it('serverError logs before responding', () => {
    // A handler that throws while responding still leaves the operator a record.
    const order = [];
    vi.spyOn(console, 'error').mockImplementation(() => order.push('log'));
    const r = res();
    r.json = () => { order.push('json'); return r; };

    serverError(r, new Error('x'), 'GET /thing');

    expect(order).toEqual(['log', 'json']);
  });

  it('callerError falls back to 400 for an error carrying no status', () => {
    const r = res();
    callerError(r, new Error('That code is not valid'));
    expect(r.sent.status).toBe(400);
    expect(r.sent.body.message).toBe('That code is not valid');
  });
});
