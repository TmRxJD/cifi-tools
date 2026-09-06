'use strict';
// FULL NODE AUDIT: every talent and attribute, every hunter -- and every place code hard-codes an
// id that does not exist for all three.
//
//   node tools/bench/node-audit.js            # audit + hazards
//   node tools/bench/node-audit.js --list     # just print the inventory
//
// WHY THIS EXISTS. `bossTimeless` pinned the attribute id `timeless`. Borge and Ozzy call that node
// `timeless`; KNOX CALLS IT `time`. Same node, same label "Timeless Mastery", same cap 5. So the
// mode threw `Cannot pin unknown attribute "timeless"` on every Knox run -- a whole objective dead
// for a third of the hunters.
//
// WHAT WAS *NOT* WRONG, because scoping this correctly is the difference between a fix and a
// rewrite: the node itself was always modelled. Knox's `time` is in HUNTER_DEFS with the right
// label, cost and cap, and scene-defs-test / attribute-tree-check confirm every count, cap, cost,
// dependency edge and spend threshold against the GAME's own authored data for all three hunters.
// The data was right. One consumer hard-coded an id.
//
// So the hazard this audit hunts is not a missing node. It is: A SHIPPED FILE MENTIONING AN ID
// THAT ONLY SOME HUNTERS HAVE. Every such mention is code that either already breaks for the other
// hunters or is one refactor away from it.
//
// It also reports LABEL COLLISIONS -- one game node carrying different ids per hunter -- because
// that is the underlying data smell that made the bug possible, and there may be more of them.

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const LIST_ONLY = process.argv.includes('--list');
const HUNTERS = ['borge', 'ozzy', 'knox'];
const PUBLIC = path.join(__dirname, '../../webapp/public');

let failures = 0;
let checked = 0;
const fail = (m) => { failures++; console.log('FAIL  ' + m); };
const ok = (m) => console.log('ok    ' + m);

const defs = H.hunterDefs();

// ---------------------------------------------------------------------------------------------
// 1. THE INVENTORY.
const nodes = {};   // hunter -> { talents:[], attributes:[] }
for (const h of HUNTERS) {
  nodes[h] = { talents: defs[h].talents || [], attributes: defs[h].attributes || [] };
}

console.log('NODE INVENTORY');
for (const h of HUNTERS) {
  const t = nodes[h].talents;
  const a = nodes[h].attributes;
  console.log(`\n${h}  --  ${t.length} talents, ${a.length} attributes`);
  const row = (n) => `    ${String(n.id).padEnd(12)} cap ${String(n.maxLevel).padEnd(8)} `
    + `cost ${String(n.cost === undefined ? '-' : n.cost).padEnd(3)} ${n.label || ''}`;
  console.log('  talents:');
  for (const n of t) console.log(row(n));
  console.log('  attributes:');
  for (const n of a) console.log(row(n));
}
if (LIST_ONLY) process.exit(0);

// ---------------------------------------------------------------------------------------------
// 2. LABEL COLLISIONS: one game node, different ids per hunter.
console.log('\n\nSHARED NODES WHOSE IDS DISAGREE ACROSS HUNTERS');
const byLabel = new Map();   // label -> Map(hunter -> id)
for (const h of HUNTERS) {
  for (const kind of ['talents', 'attributes']) {
    for (const n of nodes[h][kind]) {
      if (!n.label) continue;
      const key = `${kind}:${n.label}`;
      if (!byLabel.has(key)) byLabel.set(key, new Map());
      byLabel.get(key).set(h, n.id);
    }
  }
}
const collisions = [];
for (const [key, m] of byLabel) {
  if (m.size < 2) continue;
  const ids = new Set(m.values());
  if (ids.size > 1) collisions.push({ key, m });
}
checked++;
if (!collisions.length) {
  ok('every node shared between hunters uses the same id in each');
} else {
  // REPORTED, NOT FAILED. The ids are ours, the labels are the game's; an inconsistency is a
  // hazard, not a defect, and renaming ids would break saved builds. What must not happen is code
  // binding to one of them -- which section 3 is what actually gates.
  for (const c of collisions) {
    const parts = [...c.m.entries()].map(([h, id]) => `${h}=${id}`).join('  ');
    console.log(`HAZARD  ${c.key.padEnd(34)} ${parts}`);
  }
  console.log(`        ${collisions.length} shared node(s) carry different ids per hunter.`);
  console.log('        Any code binding to one of these ids is broken for the others -- section 3');
  console.log('        is the gate; this list is where to look first.');
}

// ---------------------------------------------------------------------------------------------
// 3. THE GATE: a shipped file must not depend on an id that only some hunters have.
console.log('\n\nNON-UNIVERSAL IDS MENTIONED IN SHIPPED CODE');
const idHunters = new Map();  // id -> Set(hunter)
for (const h of HUNTERS) {
  for (const kind of ['talents', 'attributes']) {
    for (const n of nodes[h][kind]) {
      if (!idHunters.has(n.id)) idHunters.set(n.id, new Set());
      idHunters.get(n.id).add(h);
    }
  }
}
const nonUniversal = [...idHunters.entries()]
  .filter(([, hs]) => hs.size < HUNTERS.length)
  .map(([id, hs]) => ({ id, hunters: [...hs] }));

// Only files that run for EVERY hunter can be caught this way. hunterDefs.js legitimately names
// every id (it is the table), and the per-hunter fixture files legitimately name their own.
const SKIP_FILES = new Set(['hunterDefs.js']);
const files = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js') && !SKIP_FILES.has(f))
  .map((f) => ({ rel: f, abs: path.join(PUBLIC, f) }));
for (const sub of ['optimizer']) {
  for (const f of fs.readdirSync(path.join(PUBLIC, sub)).filter((x) => x.endsWith('.js'))) {
    files.push({ rel: `${sub}/${f}`, abs: path.join(PUBLIC, sub, f) });
  }
}

const hits = [];
// WHAT COUNTS AS A HAZARD, precisely -- the first version flagged 116 things and was useless.
//
// Naming a non-universal id is FINE when the surrounding code is already scoped to that hunter.
// saveImport.js has `knox: ['kraken', 'spa', ...]`, which is a per-hunter table and exactly how
// this data SHOULD be written. Flagging it buries the one real hazard in noise, and a check nobody
// can read is a check nobody runs.
//
// A mention is scoped, and therefore fine, when:
//   - it sits in a comment (documentation, not behaviour), OR
//   - the line names a hunter, and every non-universal id on that line belongs to that hunter.
// Anything else is code that runs for all hunters while naming an id only some of them have.
// NO REGEX HERE, DELIBERATELY. Four separate patches in this session had a backslash level eaten
// by the shell heredoc, turning an escaped newline into a real one and an escaped b into a
// backspace character. Character scanning needs no escapes and cannot acquire that bug.
const NL = String.fromCharCode(10);   // written this way for the same escape reason
const stripComments = (src) => {
  const out = [];
  let inBlock = false;
  for (const raw of src.split(NL)) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*' + '/');
      if (end < 0) { out.push(''); continue; }
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = line.indexOf('/' + '*');
      if (start < 0) break;
      const end = line.indexOf('*' + '/', start + 2);
      if (end < 0) { line = line.slice(0, start); inBlock = true; break; }
      line = line.slice(0, start) + ' ' + line.slice(end + 2);
    }
    const lineComment = line.indexOf('/' + '/');
    if (lineComment >= 0) line = line.slice(0, lineComment);
    out.push(line);
  }
  return out.join(NL);
};

for (const { rel, abs } of files) {
  const lines = stripComments(fs.readFileSync(abs, 'utf8')).split(NL);
  lines.forEach((code, i) => {
    const named = nonUniversal.filter(({ id }) => code.includes(`'${id}'`) || code.includes(`"${id}"`));
    if (!named.length) return;
    // Case-insensitive: prose and error messages capitalise them ("Timeless Mastery is
    // \"timeless\" on Borge/Ozzy, \"time\" on Knox"), and that line is precisely a line that
    // handles the difference correctly rather than assuming it away.
    const lower = code.toLowerCase();
    const huntersOnLine = HUNTERS.filter((h) => lower.includes(h));
    // SCOPED, and therefore fine, in two shapes:
    //  (a) one hunter on the line owns EVERY id named there -- a per-hunter table such as
    //      buildCode's `borge: ['revival', 'loth', ...]`. Note the test is "borge has all of
    //      these", NOT "these belong only to borge": `pog` is shared with Knox and `ultima` with
    //      Ozzy, and requiring exclusivity flagged every legitimate table in the codebase.
    //  (b) every hunter is named on the line, i.e. the code is explicitly handling the difference
    //      rather than assuming it away -- which is what a correct fix looks like.
    const ownedByOne = huntersOnLine.some((h) => named.every(({ hunters }) => hunters.includes(h)));
    const handlesAll = HUNTERS.every((h) => huntersOnLine.includes(h));
    //  (c) the line IS a per-hunter table entry (`borge: [...]`). Section 4 checks those against
    //      the defs properly; matching ids inside them here only re-reports the same thing as
    //      dozens of separate hits.
    const trimmed = code.trim();
    const isTableRow = HUNTERS.some((h) => trimmed.startsWith(h + ':'));
    if (ownedByOne || handlesAll || isTableRow) return;
    for (const { id, hunters } of named) {
      hits.push({ rel, line: i + 1, id, hunters, text: code.trim().slice(0, 100) });
    }
  });
}

checked++;
if (!hits.length) {
  ok(`no shipped file binds to any of the ${nonUniversal.length} non-universal id(s)`);
} else {
  for (const h of hits) {
    fail(`${h.rel}:${h.line} references '${h.id}', which only ${h.hunters.join('/')} have`);
    console.log(`        ${h.text}`);
  }
  console.log('');
  console.log('      Each of these runs for every hunter but names an id some hunters do not have.');
  console.log('      That is the bossTimeless crash exactly. Resolve by LABEL (the game name, which');
  console.log('      is identical across hunters) rather than by id -- see Objective.pinnedAttrsFor.');
}

console.log('');
console.log(`${nonUniversal.length} non-universal id(s): `
  + nonUniversal.map((n) => `${n.id}(${n.hunters.join('+')})`).join(', '));

// ---------------------------------------------------------------------------------------------
// 4. THE SHARE-CODE WIRE FORMAT vs WHAT WE MODEL.
//
// CODE_PARAMS fixes the ORDER of values in a build code, so it is a wire format and not a list of
// our nodes. A name in it that we do not model is therefore not automatically a bug -- but it MUST
// be deliberate, because the alternative reading (a node we forgot) is exactly what this audit is
// for. Each one is listed with its reason or it fails.
const WIRE_ONLY = {
  // Knox HAS a ninth talent in the game -- the Ultima signature, cap 50 -- and we deliberately do
  // not model it: params.json exposes no `ultima` argument for Knox, so the evaluator has nowhere
  // to put it and the input would reach nothing. It stays in the wire format because the position
  // is load-bearing; removing it would shift every later field and corrupt every Knox code.
  'knox:ultima': 'game talent with no wasm argument for Knox -- position kept for wire compatibility',
};
console.log('');
console.log('');
console.log('SHARE-CODE PARAMS THAT NAME A NODE THE HUNTER DOES NOT MODEL');
const codeParams = H.browserSandbox().CODE_PARAMS;
if (!codeParams) {
  fail('CODE_PARAMS is not reachable from the harness -- section 4 verified nothing');
  checked++;
} else {
  for (const h of HUNTERS) {
    const own = new Set([...nodes[h].talents, ...nodes[h].attributes].map((n) => n.id));
    const allIds = new Set(idHunters.keys());
    for (const param of codeParams[h] || []) {
      // Only node-shaped params: `upgrades.*` and base stats are a different namespace.
      if (!allIds.has(param) || own.has(param)) continue;
      checked++;
      const key = `${h}:${param}`;
      if (WIRE_ONLY[key]) ok(`${key} -- ${WIRE_ONLY[key]}`);
      else fail(`${key}: the share code carries this node but ${h} does not model it, and no reason is recorded`);
    }
  }
  if (!checked) console.log('      (none)');
}

console.log('');
if (!checked) { console.log('FAIL  node-audit compared nothing'); process.exit(1); }
if (failures) { console.log(`FAIL  ${failures} hazard(s) that would break a hunter`); process.exit(1); }
console.log('PASS  no shipped code binds to a non-universal node id');
