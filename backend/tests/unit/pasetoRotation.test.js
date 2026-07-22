// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Rotating the auth signing secret must NOT log everyone out: tokens signed
// under the old secret must keep verifying until they age out, as long as the
// old secret is retained in JWT_PREVIOUS_SECRETS / PASETO_PREVIOUS_SECRETS. This
// pins that overlap (paseto.util.js derives each retained secret's public key and
// adds it to the verify set) and proves the drop-the-old-key end state rejects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OLD = 'old-paseto-signing-secret-value-000000';
const NEW = 'new-paseto-signing-secret-value-111111';
const ENV_KEYS = ['JWT_SECRET', 'PASETO_SECRET_KEY', 'PASETO_PREVIOUS_SECRETS', 'JWT_PREVIOUS_SECRETS', 'PASETO_PREVIOUS_PUBLIC_KEYS'];

const saved = {};
beforeEach(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.resetModules();
});

// Re-import paseto.util.js fresh under a specific env (it reads keys at module load).
async function pasetoWith(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import('../../domains/identity/paseto.util.js');
}

describe('PASETO auth-key rotation (zero forced logout)', () => {
  it('verifies an OLD-secret token after rotation via JWT_PREVIOUS_SECRETS', async () => {
    const oldMod = await pasetoWith({ JWT_SECRET: OLD });
    const token = oldMod.signToken({ userId: 'u1' });

    const newMod = await pasetoWith({ JWT_SECRET: NEW, JWT_PREVIOUS_SECRETS: OLD });
    expect(newMod.verifyPaseto(token).userId).toBe('u1');                              // pre-rotation token still valid
    expect(newMod.verifyPaseto(newMod.signToken({ userId: 'u2' })).userId).toBe('u2'); // new tokens verify too
  });

  it('also honors the PASETO-native alias PASETO_PREVIOUS_SECRETS', async () => {
    const oldMod = await pasetoWith({ JWT_SECRET: OLD });
    const token = oldMod.signToken({ userId: 'u3' });

    const newMod = await pasetoWith({ JWT_SECRET: NEW, PASETO_PREVIOUS_SECRETS: OLD });
    expect(newMod.verifyPaseto(token).userId).toBe('u3');
  });

  it('rejects the OLD-secret token once the previous secret is dropped', async () => {
    const oldMod = await pasetoWith({ JWT_SECRET: OLD });
    const token = oldMod.signToken({ userId: 'u1' });

    const newMod = await pasetoWith({ JWT_SECRET: NEW }); // old secret no longer retained
    expect(() => newMod.verifyPaseto(token)).toThrow();
  });
});
