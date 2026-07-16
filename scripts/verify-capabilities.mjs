// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file.
/**
 * scripts/verify-capabilities.mjs — Platform Capability Registry verifier.
 *
 * Makes the capability registry (platform/capabilities.yaml) executable truth
 * instead of prose: on every CI run it asserts that each capability's claimed
 * EVIDENCE files and DOCS actually exist on disk, that any named VERIFICATION
 * test exists, and that the registry is internally consistent (valid statuses,
 * buckets, and dependency references). If someone deletes jwt.util.js but leaves
 * the registry claiming JWT auth is FULL, this fails the build — capability #6
 * (architecture-drift detection) made real, and the mechanism that keeps the
 * docs synchronized with the code (the owner's "one thing I would add").
 *
 * Exit 0 = registry consistent with the tree; exit 1 = drift.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = path.join(ROOT, 'platform', 'capabilities.yaml');

const IMPL_STATUSES = ['full', 'partial', 'architecture-ready', 'absent', 'decision'];
const ACTIVATION = ['active', 'dormant', 'infra-gated', 'volume-gated', 'n/a'];
const BUCKETS = ['A', 'B', 'C', 'decision'];

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function main() {
  if (!fs.existsSync(REGISTRY)) {
    console.error(`FATAL: registry not found at ${REGISTRY}`);
    process.exit(1);
  }
  const reg = yaml.load(fs.readFileSync(REGISTRY, 'utf8'));
  const caps = reg?.capabilities || [];
  if (!caps.length) { console.error('FATAL: registry has no capabilities'); process.exit(1); }

  const ids = new Set(caps.map((c) => c.id));
  const errors = [];
  const counts = { full: 0, partial: 0, 'architecture-ready': 0, absent: 0, decision: 0 };

  for (const c of caps) {
    const at = `${c.id} (${c.name || '?'})`;
    if (!c.id) errors.push(`capability missing id: ${JSON.stringify(c).slice(0, 80)}`);
    if (!BUCKETS.includes(c.bucket)) errors.push(`${at}: invalid bucket "${c.bucket}"`);
    if (!IMPL_STATUSES.includes(c.implementation_status)) errors.push(`${at}: invalid implementation_status "${c.implementation_status}"`);
    if (c.activation_status && !ACTIVATION.includes(c.activation_status)) errors.push(`${at}: invalid activation_status "${c.activation_status}"`);
    if (!c.owner) errors.push(`${at}: missing owner`);
    counts[c.implementation_status] = (counts[c.implementation_status] || 0) + 1;

    // Evidence + verification files are REQUIRED to exist for anything claiming
    // code (full/partial/architecture-ready). absent/decision may legitimately
    // have none.
    const claimsCode = ['full', 'partial', 'architecture-ready'].includes(c.implementation_status);
    for (const ev of c.evidence || []) {
      if (!exists(ev)) errors.push(`${at}: EVIDENCE missing on disk → ${ev}`);
    }
    if (claimsCode && !(c.evidence || []).length && !(c.verification && c.verification.command)) {
      errors.push(`${at}: status "${c.implementation_status}" but no evidence files listed`);
    }
    if (c.verification?.test && !exists(c.verification.test)) {
      errors.push(`${at}: VERIFICATION test missing on disk → ${c.verification.test}`);
    }
    for (const doc of [].concat(c.docs || [])) {
      if (doc && !exists(doc)) errors.push(`${at}: DOCS missing on disk → ${doc}`);
    }
    for (const dep of c.dependencies || []) {
      if (!ids.has(dep)) errors.push(`${at}: dependency "${dep}" is not a known capability id`);
    }
  }

  console.log(`Platform Capability Registry — ${caps.length} capabilities`);
  console.log(`  full: ${counts.full} · partial: ${counts.partial} · architecture-ready: ${counts['architecture-ready']} · absent: ${counts.absent} · decision: ${counts.decision}`);

  if (errors.length) {
    console.error(`\n✗ ${errors.length} registry/drift problem(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('✓ Registry is consistent with the codebase (evidence, docs, tests, deps all resolve).');
  process.exit(0);
}

main();
