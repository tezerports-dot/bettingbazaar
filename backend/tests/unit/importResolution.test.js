// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Guards against the bug class that took down production on 2026-07-09: a
// DYNAMIC import() with a wrong relative path. node --check and static module
// loading never catch these — they only resolve at runtime when that code
// path fires. This test statically resolves EVERY dynamic import in backend/
// against the file's real location, so a broken path fails CI immediately.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('every relative dynamic import() resolves to a real file', () => {
  it('has no broken dynamic import paths in backend/', () => {
    const re = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    const broken = [];
    for (const f of walk(backendDir)) {
      const src = readFileSync(f, 'utf8');
      let m;
      while ((m = re.exec(src))) {
        const target = resolve(dirname(f), m[1]);
        if (!existsSync(target)) {
          const line = src.slice(0, m.index).split('\n').length;
          broken.push(`${f}:${line} -> ${m[1]}`);
        }
      }
    }
    expect(broken, `broken dynamic imports:\n${broken.join('\n')}`).toEqual([]);
  });
});
