'use strict';
// Measures the concrete surface a TypeScript (or JSDoc + checkJs) conversion would have to
// cover, so the decision rests on counts rather than impressions. Re-run it to track progress.
//
//   node tools/bench/ts-readiness.js
//
// Columns:
//   lines      file size
//   gWrite     `window.X =` declarations -- each needs a declared type on the global surface
//   byId       getElementById calls -- each returns HTMLElement|null and needs narrowing
//   qSel       querySelector/All calls -- same, plus a cast to the specific element type
//   innerHTML  innerHTML assignments -- untyped string templating, invisible to a type checker
//   jsdoc      existing /** */ blocks -- the head start on annotation

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '../../webapp/public');
const files = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js')).map((f) => ['', f])
  .concat(fs.readdirSync(path.join(PUBLIC, 'optimizer')).filter((f) => f.endsWith('.js')).map((f) => ['optimizer', f]));

const globals = new Set();
const rows = [];
const totals = { lines: 0, gWrite: 0, byId: 0, qSel: 0, innerHTML: 0, jsdoc: 0 };

for (const [dir, f] of files) {
  const src = fs.readFileSync(path.join(PUBLIC, dir, f), 'utf8');
  for (const m of src.matchAll(/^\s*(?:window|global)\.([A-Za-z_$][\w$]*)\s*=/gm)) globals.add(m[1]);
  const row = {
    rel: dir ? `${dir}/${f}` : f,
    lines: src.split('\n').length,
    gWrite: [...src.matchAll(/^\s*(?:window|global)\.([A-Za-z_$][\w$]*)\s*=/gm)].length,
    byId: (src.match(/getElementById\(/g) || []).length,
    qSel: (src.match(/querySelector(All)?\(/g) || []).length,
    innerHTML: (src.match(/\.innerHTML\s*=/g) || []).length,
    jsdoc: (src.match(/\/\*\*/g) || []).length,
  };
  rows.push(row);
  for (const k of Object.keys(totals)) totals[k] += row[k];
}

const cols = ['lines', 'gWrite', 'byId', 'qSel', 'innerHTML', 'jsdoc'];
const line = (label, o) => `${label.padEnd(28)}${cols.map((c) => String(o[c]).padStart(10)).join('')}`;
console.log(`${'file'.padEnd(28)}${cols.map((c) => c.padStart(10)).join('')}`);
rows.sort((a, b) => b.lines - a.lines).forEach((r) => console.log(line(r.rel, r)));
console.log('-'.repeat(28 + 10 * cols.length));
console.log(line('TOTAL', totals));
console.log(`\ndistinct cross-file globals: ${globals.size}`);
console.log(`two largest files are ${((rows[0].lines + rows[1].lines) / totals.lines * 100).toFixed(0)}% of all code`);
