// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Two indexes on ONE key pattern with different options is a schema bug that no
 * amount of reading catches and no unit test used to catch either.
 *
 * ── How it happens ──────────────────────────────────────────────────────────
 * A field is marked `index: true` for lookups, and later someone adds the rule
 * that field really needs — a TTL, or a partial unique constraint — as a
 * separate `schema.index()` call. Both declarations name the same key. Mongoose
 * accepts it happily; MongoDB refuses at build time.
 *
 * ── Why it is invisible ─────────────────────────────────────────────────────
 * Indexes are built when a model is first used against a live connection, so
 * nothing surfaces until an integration run touches that specific model — or
 * worse, until `npm run sync:indexes` is run on the production box during a
 * deploy. A model that no test exercises can carry the fault indefinitely.
 *
 * This suite reads the declared indexes straight off the compiled schemas. It
 * needs no database, runs in milliseconds, and covers EVERY registered model
 * rather than only the ones some test happens to write to.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';

/** The options that make two same-key indexes genuinely different objects. */
function optionSignature(opts = {}) {
  return JSON.stringify({
    unique: Boolean(opts.unique),
    partialFilterExpression: opts.partialFilterExpression ?? null,
    expireAfterSeconds: opts.expireAfterSeconds ?? null,
    sparse: Boolean(opts.sparse),
    collation: opts.collation ?? null,
  });
}

describe('no model declares two indexes on the same key with different options', () => {
  it('every registered schema is internally consistent', () => {
    const conflicts = [];

    for (const [modelName, model] of Object.entries(mongoose.models)) {
      const seen = new Map();   // key signature -> option signature
      for (const [keys, opts] of model.schema.indexes()) {
        const keySig = JSON.stringify(keys);
        const optSig = optionSignature(opts);
        if (seen.has(keySig) && seen.get(keySig) !== optSig) {
          conflicts.push(
            `${modelName} declares ${keySig} twice with different options:\n` +
            `      ${seen.get(keySig)}\n  vs  ${optSig}`,
          );
        }
        seen.set(keySig, optSig);
      }
    }

    // Named individually so a failure says WHICH model and WHICH key, rather
    // than only that a count changed.
    expect(conflicts, `\n${conflicts.join('\n')}\n`).toEqual([]);
  });

  it('covers a meaningful number of models (guards against an empty sweep)', () => {
    // If models/index.js ever stops registering, the assertion above would pass
    // vacuously. This makes that failure mode loud.
    expect(Object.keys(mongoose.models).length).toBeGreaterThan(20);
  });
});
