// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Mongoose 9 upgrade contract (no DB — runs in the unit suite).
 *
 * The 8→9 bump broke integration in two ways that unit-level tests can pin
 * WITHOUT a live mongod, so a regression is caught on every push instead of
 * only when the integration suite runs against real MongoDB:
 *
 *  1. kareem 3 removed the next() callback from middleware. Every
 *     `schema.pre(name, function (next) { … next() })` now throws
 *     "TypeError: next is not a function" the moment the hook fires — which on
 *     the money models means a save/validate/append-only-guard blows up. A
 *     correctly-migrated hook declares ZERO parameters (it throws to reject and
 *     returns/awaits to continue), so we assert no registered PRE hook still
 *     declares a callback parameter.
 *
 *  2. Mongoose 9 makes aggregation-pipeline updates throw unless the
 *     `updatePipeline` option is set. runPhantomEqualizer and other paths use
 *     them, so startup/mongooseGlobalOptions.js sets it globally; importing the
 *     models barrel must put it in force.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
// Importing the barrel registers every model AND pulls in
// startup/mongooseGlobalOptions.js for its side effect.
import * as models from '../../models/index.js';

beforeAll(() => {
  // Touch the namespace so the import is never tree-shaken away.
  expect(Object.keys(models).length).toBeGreaterThan(0);
});

describe('Mongoose 9 global options', () => {
  it('enables update pipelines globally (loading the barrel is enough)', () => {
    // Without this, Model.updateOne(filter, [ {$set…} ]) throws
    // "Cannot pass an array to query updates unless the `updatePipeline` option
    // is set" — silently swallowed inside runPhantomEqualizer's try/catch.
    expect(mongoose.get('updatePipeline')).toBe(true);
  });
});

describe('no callback-style (next-taking) Mongoose middleware remains', () => {
  it('every registered PRE hook declares zero parameters', () => {
    const offenders = [];
    for (const [modelName, model] of Object.entries(mongoose.models)) {
      const pres = model.schema?.s?.hooks?._pres;
      if (!(pres instanceof Map)) continue;
      for (const [hookName, entries] of pres) {
        for (const entry of entries) {
          // arity > 0 == the pre-9 `function (next) {…}` signature, which
          // kareem 3 no longer feeds a callback → "next is not a function".
          if (typeof entry.fn === 'function' && entry.fn.length > 0) {
            offenders.push(`${modelName}.pre('${hookName}') → ${entry.fn.name || '(anonymous)'} takes ${entry.fn.length} param(s)`);
          }
        }
      }
    }
    expect(offenders, `callback-style middleware breaks under Mongoose 9:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('the ensurePublicRef validate hook runs end to end (no next())', () => {
  it('assigns publicRef during validate without throwing "next is not a function"', async () => {
    const Merchant = mongoose.model('Merchant');
    const m = new Merchant({});
    // validate() runs pre('validate') offline (no connection needed). Required-
    // field errors are expected and ignored; the point is that the hook itself
    // executed and set publicRef rather than throwing on a missing callback.
    let hookError = null;
    await m.validate().catch((err) => { hookError = err; });
    if (hookError) {
      expect(String(hookError.message)).not.toMatch(/next is not a function/i);
    }
    expect(m.publicRef).toBeTruthy();
  });
});
