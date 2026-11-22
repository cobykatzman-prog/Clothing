// Regression guard for "a JS syntax error blanked the whole app" (it has happened: js/home.js, commit ac71b7a).
// Every browser module and every server file must parse (`node --check`), every relative import must resolve to a real file,
// and every named import must be something the target module actually exports. Pure Node, runs in about a second.
// Run: node test/syntax.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL:', name, '\n', e.message); process.exitCode = 1; } };
const jsFiles = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => path.join('js', f));
const serverFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.mjs')).concat(fs.readdirSync(path.join(ROOT, 'test')).filter(f => /\.(mjs|cjs)$/.test(f)).map(f => 'test/' + f));
const scripts = fs.existsSync(path.join(ROOT, 'scripts')) ? fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => /\.(mjs|cjs|js)$/.test(f)).map(f => 'scripts/' + f) : [];

t('there are browser modules to check', () => assert.ok(jsFiles.length > 50, 'found ' + jsFiles.length));
t('every js/*.js, server, script and test file parses (node --check)', () => {
  const bad = [];
  for (const f of [...jsFiles, ...serverFiles, ...scripts]) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(f + ': ' + String(r.stderr).split('\n').slice(0, 4).join(' | '));
  }
  assert.deepEqual(bad, [], 'syntax errors:\n' + bad.join('\n'));
});

/* export / import consistency (comment-aware enough for this code base) */
const strip = s => s;   // statements are matched at the start of a line, so comments cannot produce false matches
function exportsOf(file) {
  const src = strip(fs.readFileSync(file, 'utf8')), out = new Set(), star = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) { const p = part.trim(); if (p) out.add(p.split(/\s+as\s+/).pop().trim()); }
  if (/^export\s+default\b/m.test(src)) out.add('default');
  for (const m of src.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) star.push(m[1]);
  for (const s of star) { const f = path.resolve(path.dirname(file), s); if (fs.existsSync(f)) for (const e of exportsOf(f)) out.add(e); }
  return out;
}
t('every relative import resolves and every imported name is exported by its target', () => {
  const problems = [], cache = new Map();
  for (const rel of jsFiles) {
    const file = path.join(ROOT, rel), src = strip(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/^import\s+(?:([\s\S]*?)\s+from\s+)?['"](\.[^'"]+)['"]/gm)) {
      const target = path.resolve(path.dirname(file), m[2]);
      if (!fs.existsSync(target)) { problems.push(`${rel}: imports missing file ${m[2]}`); continue; }
      if (!m[1]) continue;
      if (!cache.has(target)) cache.set(target, exportsOf(target));
      const ex = cache.get(target), clause = m[1];
      const named = /\{([\s\S]*)\}/.exec(clause);
      if (named) for (const part of named[1].split(',')) { const nm = part.trim().split(/\s+as\s+/)[0].trim(); if (nm && !ex.has(nm)) problems.push(`${rel}: ${nm} is not exported by ${m[2]}`); }
      const def = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+\w+/, '').replace(/,/g, '').trim();
      if (def && !ex.has('default')) problems.push(`${rel}: default import from ${m[2]} which has no default export`);
    }
    for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) if (!fs.existsSync(path.resolve(path.dirname(file), m[1]))) problems.push(`${rel}: dynamic import of missing file ${m[1]}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

t('index.html loads only files that exist and has no inline script or handler (CSP)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), 'index.html references missing ' + m[1]);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[^<]/i.test(html), 'inline script would be blocked by CSP');
  assert.ok(!/\son\w+="/i.test(html), 'inline event handler attributes are blocked by CSP');
});

t('the entry module graph is closed: everything reachable from js/main.js exists', () => {
  const seen = new Set(), stack = [path.join(ROOT, 'js/main.js')];
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
    assert.ok(fs.existsSync(f), 'missing ' + path.relative(ROOT, f));
    const src = strip(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/(?:^import\s[^'"]*?from\s+|^import\s+|import\()\s*['"](\.[^'"]+)['"]/gm)) stack.push(path.resolve(path.dirname(f), m[1]));
  }
  assert.ok(seen.size > 30);
});
console.log(`syntax.test: ${n} passed`);
