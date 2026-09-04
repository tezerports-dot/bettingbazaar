// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the AQ-6 Express-5-safe request-key sanitizer. It replaced a
// package that reassigned req.query, which Express 5 makes read-only.
import { describe, it, expect } from 'vitest';
import { sanitizeInPlace, inputSanitize } from '../../middleware/inputSanitize.js';

describe('sanitizeInPlace', () => {
  it('strips $-prefixed operator keys (NoSQL injection)', () => {
    const o = { mobile: '9990001111', password: { $gt: '' } };
    sanitizeInPlace(o);
    expect(o.password).toEqual({}); // $gt removed
    expect(o.mobile).toBe('9990001111');
  });

  it('strips dotted keys (nested-path injection)', () => {
    const o = { 'user.role': 'admin', ok: 1 };
    sanitizeInPlace(o);
    expect(o['user.role']).toBeUndefined();
    expect(o.ok).toBe(1);
  });

  it('recurses into nested objects and arrays', () => {
    const o = { a: { $ne: null, keep: 2 }, list: [{ $where: 'x', good: 3 }] };
    sanitizeInPlace(o);
    expect(o.a.$ne).toBeUndefined();
    expect(o.a.keep).toBe(2);
    expect(o.list[0].$where).toBeUndefined();
    expect(o.list[0].good).toBe(3);
  });

  it('mutates in place (same reference — Express 5 req.query safe)', () => {
    const q = { $or: [], page: '1' };
    const ref = q;
    sanitizeInPlace(q);
    expect(ref).toBe(q);        // did not reassign
    expect(q.$or).toBeUndefined();
    expect(q.page).toBe('1');
  });

  it('leaves clean values untouched', () => {
    const o = { username: 'alice', amount: 100, nested: { ok: true } };
    sanitizeInPlace(o);
    expect(o).toEqual({ username: 'alice', amount: 100, nested: { ok: true } });
  });
});

describe('inputSanitize middleware', () => {
  it('sanitizes body, params, and query, then calls next()', () => {
    const req = {
      body: { $set: { role: 'admin' }, name: 'ok' },
      params: { id: { $gt: '' } },
      query: { 'a.b': 1, page: '2' },
    };
    let called = false;
    inputSanitize(req, {}, () => { called = true; });
    expect(called).toBe(true);
    expect(req.body.$set).toBeUndefined();
    expect(req.body.name).toBe('ok');
    expect(req.params.id).toEqual({});
    expect(req.query['a.b']).toBeUndefined();
    expect(req.query.page).toBe('2');
  });

  it('tolerates missing body/params/query', () => {
    let called = false;
    expect(() => inputSanitize({}, {}, () => { called = true; })).not.toThrow();
    expect(called).toBe(true);
  });
});
