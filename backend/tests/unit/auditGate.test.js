// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The dependency audit gate tolerates exactly what the owner decided, and no
 * more (scripts/audit-gate.mjs, PR #201).
 *
 * The exception for GHSA-vfj7-8cjw-p6xm is only safe while it stays narrow:
 * one advisory, at the range that was decided on, on a package that is
 * dev-only in the lockfile, until a fixed version ships. Each of those is a
 * case below, alongside the opposite behaviour: the excepted advisory passes,
 * and an unexcepted one beside it still fails the build.
 */
import { describe, it, expect } from 'vitest';
import { judge, loadExceptions, stillVulnerable } from '../../../scripts/audit-gate.mjs';

const BRACES = {
  source: 1240992, name: 'braces', dependency: 'braces', severity: 'high', range: '<=3.0.3',
  title: 'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
};
const EXCEPTION = {
  id: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', range: '<=3.0.3', devOnly: true,
  decided: 'owner, test', reason: 'dev tooling only',
};

const auditWith = (...advisories) => ({
  vulnerabilities: {
    braces: { name: 'braces', severity: 'high', via: [BRACES], nodes: ['node_modules/braces'] },
    // A dependent names braces by string; it carries no advisory of its own.
    micromatch: { name: 'micromatch', severity: 'high', via: ['braces'], nodes: ['node_modules/micromatch'] },
    ...Object.fromEntries(advisories.map((a) => [a.name, { name: a.name, severity: a.severity, via: [a], nodes: [`node_modules/${a.name}`] }])),
  },
  metadata: { vulnerabilities: { high: 2 } },
});
const lock = (dev = true) => ({ packages: { 'node_modules/braces': { version: '3.0.3', dev }, 'node_modules/ws': { version: '8.0.0' } } });
const run = (over = {}) => judge({
  audit: auditWith(), lock: lock(), exceptions: [EXCEPTION], latestOf: () => '3.0.3', ...over,
});

describe('the audit gate', () => {
  it('tolerates the excepted advisory while braces is dev-only and unfixed', () => {
    const { blocking, tolerated } = run();
    expect(blocking).toEqual([]);
    expect(tolerated).toHaveLength(1);
    expect(tolerated[0]).toContain('GHSA-vfj7-8cjw-p6xm');
  });

  it('blocks the same advisory when nothing excepts it', () => {
    const { blocking, tolerated } = run({ exceptions: [] });
    expect(tolerated).toEqual([]);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toContain('GHSA-vfj7-8cjw-p6xm');
  });

  it('still blocks any other high advisory beside the excepted one', () => {
    const ws = { source: 1, name: 'ws', severity: 'high', range: '<8.17.1', title: 'ws DoS', url: 'https://github.com/advisories/GHSA-3h5v-q93c-6h6q' };
    const { blocking, tolerated } = run({ audit: auditWith(ws) });
    expect(tolerated).toHaveLength(1);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toContain('GHSA-3h5v-q93c-6h6q');
  });

  it('blocks a critical advisory and ignores a moderate one, as --audit-level=high does', () => {
    const crit = { source: 2, name: 'ws', severity: 'critical', range: '<1', title: 'x', url: 'https://github.com/advisories/GHSA-2222-3333-4444' };
    const mod = { source: 3, name: 'colord', severity: 'moderate', range: '<1', title: 'y', url: 'https://github.com/advisories/GHSA-5555-6666-7777' };
    const { blocking } = run({ audit: auditWith(crit, mod) });
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toContain('GHSA-2222-3333-4444');
  });

  it('stops applying the moment braces reaches a production dependency', () => {
    const { blocking, tolerated } = run({ lock: lock(false) });
    expect(tolerated).toEqual([]);
    expect(blocking[0]).toMatch(/not dev-only/);
  });

  it('stops applying, and says so, once a fixed braces is published', () => {
    const { blocking, tolerated } = run({ latestOf: () => '3.0.4' });
    expect(tolerated).toEqual([]);
    expect(blocking[0]).toMatch(/a fix exists/);
  });

  it('stops applying when the advisory is widened past the range that was decided on', () => {
    const widened = { ...BRACES, range: '<=4.0.0' };
    const audit = auditWith();
    audit.vulnerabilities.braces.via = [widened];
    const { blocking } = run({ audit });
    expect(blocking[0]).toMatch(/range is now <=4\.0\.0/);
  });

  it('refuses to judge an audit that did not report', () => {
    expect(() => run({ audit: { error: { code: 'ENOTFOUND' } } })).toThrow(/did not report/);
    expect(() => run({ lock: {} })).toThrow(/no "packages"/);
  });

  it('refuses an exception that is not narrow', () => {
    expect(() => loadExceptions({ exceptions: [{ ...EXCEPTION, devOnly: false }] })).toThrow(/dev-only/);
    expect(() => loadExceptions({ exceptions: [{ ...EXCEPTION, range: '*' }] })).toThrow(/range/);
    expect(() => loadExceptions({ exceptions: [{ ...EXCEPTION, id: 'braces' }] })).toThrow(/GHSA/);
    expect(() => loadExceptions({ exceptions: [{ ...EXCEPTION, reason: ' ' }] })).toThrow(/reason/);
    expect(loadExceptions({ exceptions: [EXCEPTION] })).toHaveLength(1);
  });

  it('reads "<=x.y.z" the way npm does', () => {
    expect(stillVulnerable('3.0.3', '<=3.0.3')).toBe(true);
    expect(stillVulnerable('3.0.2', '<=3.0.3')).toBe(true);
    expect(stillVulnerable('2.9.10', '<=3.0.3')).toBe(true);
    expect(stillVulnerable('3.0.4', '<=3.0.3')).toBe(false);
    expect(stillVulnerable('3.1.0', '<=3.0.3')).toBe(false);
    expect(stillVulnerable('4.0.0-beta.1', '<=3.0.3')).toBe(false);
  });
});
