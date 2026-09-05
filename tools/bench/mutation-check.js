'use strict';
// DOES EACH GATE ACTUALLY DETECT A FAULT? Corrupt what it validates and require it to fail.
//
// WHY THIS EXISTS. 75 of 77 gates in this directory had never been shown capable of failing. That
// is the exact class of defect that has cost this project the most: a `\b` written as a literal
// backspace byte made two benches match nothing and pass; the inscryption fleet-slot check ran its
// range assertion over an empty list and passed; a guard was added to AccountState and was dead on
// the only path where the mistake had happened. In every case the board was green and the check
// verified nothing.
//
// A gate that passes on corrupted data is not a gate. This runs each one against deliberately
// broken input and reports:
//
//   DETECTED  the gate failed on at least one corruption -- it works
//   BLIND     the gate passed on every corruption -- it does not check what it claims to
//   UNMUTATED no corruptible input was found -- unproven, which is a finding, not a pass
//
// SAFETY. Reference data is corrupted IN PLACE and restored from a byte-for-byte backup, with the
// restore verified by hash before moving on. A failed restore aborts the whole run rather than
// continuing against damaged data.
//
//   node tools/bench/mutation-check.js
//   node tools/bench/mutation-check.js --only=badge-check
//   node tools/bench/mutation-check.js --list

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const ROOT = path.join(__dirname, '../..');
const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const only = flag('only', null);
const listOnly = args.includes('--list');
const perGateTimeoutMs = Number(flag('timeout', '180000'));

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---- discover the gates all.js runs, and what each reads -------------------------------------
const allSrc = fs.readFileSync(path.join(DIR, 'all.js'), 'utf8');
// all.js distinguishes GATES from REPORTS -- a report deliberately exits 0 even when it disagrees,
// because a stronger check owns the same question. Scraping every quoted name without that
// distinction reported sirred-ship-check as a blind gate when it is a declared report doing
// exactly what it says. Read the classification rather than inventing one.
const reportsMatch = allSrc.match(/const REPORTS = \[([^\]]*)\]/);
const REPORTS = new Set(reportsMatch
  ? [...reportsMatch[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1])
  : []);
const bundleMatch = allSrc.match(/const NEEDS_BUNDLE = \[([^\]]*)\]/);
const NEEDS_BUNDLE = new Set(bundleMatch
  ? [...bundleMatch[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1])
  : []);
if (!REPORTS.size) {
  throw new Error('mutation-check: could not read the REPORTS list from all.js -- without it a '
    + 'report would be misreported as a blind gate');
}
const gateNames = [...new Set([...allSrc.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]))]
  .filter((n) => n !== 'all' && fs.existsSync(path.join(DIR, `${n}.js`)));

function inputsFor(gate) {
  const src = fs.readFileSync(path.join(DIR, `${gate}.js`), 'utf8');
  const refs = new Set();
  for (const m of src.matchAll(/reference\/([A-Za-z0-9._-]+\.json)/g)) refs.add(`tools/reference/${m[1]}`);
  for (const m of src.matchAll(/public\/([A-Za-z0-9._/-]+\.json)/g)) refs.add(`webapp/public/${m[1]}`);
  // hunterDefs.js is JS but it is a DATA TABLE -- talent caps, attribute costs, dependency lists.
  // Eleven gates read it and no JSON at all, so excluding it left them permanently unproven. Only
  // NUMERIC LITERALS in it are mutated (see jsMutations), never structure, so a detection means the
  // gate noticed a changed value rather than a syntax error.
  if (/hunterDefs|HUNTER_DEFS/.test(src)) refs.add('webapp/public/hunterDefs.js');
  return [...refs].filter((r) => fs.existsSync(path.join(ROOT, r)));
}

// ---- corruptions ------------------------------------------------------------------------------
// Several per file, because a gate legitimately checks only part of its input; detecting ANY of
// them proves the gate is live. Each returns a mutated copy or null if it does not apply.
// SEVERAL MUTATIONS SPREAD ACROSS THE WHOLE STRUCTURE, not just the first leaf.
//
// The first version changed only the first and last numeric leaf and the first string. That
// reported node-counter-check as BLIND when it demonstrably checks 77 counters -- the single
// mutation available for that file happened to land on a field the gate does not read. A gate
// legitimately checks part of its input, so proving liveness needs probes spread through it, and
// "no mutation was detected" only means something once enough of the file has been probed.
function mutations(json) {
  const out = [];
  const clone = () => JSON.parse(JSON.stringify(json));

  // Collect every leaf path, typed.
  const numPaths = [];
  const strPaths = [];
  const walk = (o, p = []) => {
    if (typeof o === 'number' && Number.isFinite(o)) numPaths.push(p);
    else if (typeof o === 'string' && o.length > 1) strPaths.push(p);
    else if (Array.isArray(o)) o.forEach((v, i) => walk(v, p.concat(i)));
    else if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], p.concat(k));
  };
  walk(json);

  const setAt = (obj, p, fn) => {
    let ref = obj;
    for (let i = 0; i < p.length - 1; i++) ref = ref[p[i]];
    ref[p[p.length - 1]] = fn(ref[p[p.length - 1]]);
  };

  // Spread probes evenly rather than clustering at the start: a gate that only reads the tail is
  // as real as one that only reads the head.
  const spread = (paths, n) => {
    if (!paths.length) return [];
    const step = Math.max(1, Math.floor(paths.length / n));
    const picked = [];
    for (let i = 0; i < paths.length && picked.length < n; i += step) picked.push(paths[i]);
    if (!picked.includes(paths[paths.length - 1])) picked.push(paths[paths.length - 1]);
    return picked;
  };

  for (const p of spread(numPaths, 5)) {
    const m = clone();
    setAt(m, p, (v) => v * 3 + 7);
    out.push({ what: `number at ${p.join('.').slice(0, 40)} x3+7`, data: m });
  }
  for (const p of spread(strPaths, 4)) {
    // Skip provenance fields: renaming _source proves nothing about the data a gate compares.
    if (p.some((seg) => typeof seg === 'string' && seg.startsWith('_'))) continue;
    const m = clone();
    setAt(m, p, (v) => `${v}_MUTATED`);
    out.push({ what: `string at ${p.join('.').slice(0, 40)} renamed`, data: m });
  }

  // Structural removals -- a gate must notice missing data, not only wrong data.
  if (Array.isArray(json) && json.length > 1) {
    const a = clone(); a.pop();
    out.push({ what: 'last array entry removed', data: a });
    const b = clone(); b.shift();
    out.push({ what: 'first array entry removed', data: b });
  } else if (json && typeof json === 'object') {
    const keys = Object.keys(json).filter((k) => !k.startsWith('_'));
    for (const k of spread(keys.map((x) => [x]), 2)) {
      const m = clone();
      delete m[k[0]];
      out.push({ what: `key "${k[0]}" removed`, data: m });
    }
  }
  return out;
}

// Mutations for a JS DATA FILE: change one numeric literal in a `key: number` pair. Structure is
// never touched, so a gate that fails did so because a VALUE changed, not because the file stopped
// parsing. Provenance-ish keys are skipped for the same reason `_source` is skipped in JSON.
function jsMutations(src) {
  const out = [];
  const skip = /^(v|version|width|height|index|id)$/i;
  const re = /(\b[A-Za-z_][A-Za-z0-9_]*\s*:\s*)(\d+)(\s*[,}\n])/g;
  const hits = [];
  let m;
  while ((m = re.exec(src))) {
    const key = m[1].split(':')[0].trim();
    if (!skip.test(key) && Number(m[2]) !== 0) hits.push({ index: m.index, full: m[0], pre: m[1], num: m[2], post: m[3], key });
  }
  if (!hits.length) return out;
  const step = Math.max(1, Math.floor(hits.length / 6));
  for (let i = 0; i < hits.length && out.length < 6; i += step) {
    const h = hits[i];
    const mutated = src.slice(0, h.index) + h.pre + (Number(h.num) * 3 + 7) + h.post
      + src.slice(h.index + h.full.length);
    out.push({ what: `${h.key}: ${h.num} -> ${Number(h.num) * 3 + 7}`, text: mutated });
  }
  return out;
}

function runGate(gate) {
  // A gate that SKIPS for a missing input verified nothing -- reporting that as "passed the
  // corruption" would brand it blind when it never ran. all.js already treats SKIP as its own
  // status; this must too, or the two disagree about the same run.
  try {
    const out = execFileSync(process.execPath, [path.join(DIR, `${gate}.js`)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: perGateTimeoutMs,
    });
    return { code: 0, skipped: /^\s*(SKIP|skip)\b/m.test(out) };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    return {
      code: e.status === undefined ? 1 : e.status,
      killed: e.killed === true,
      skipped: /^\s*(SKIP|skip)\b/m.test(out),
    };
  }
}

(async () => {
  const targets = gateNames
    .map((g) => ({ gate: g, inputs: inputsFor(g) }))
    .filter((t) => (only ? t.gate === only : true));

  if (listOnly) {
    for (const t of targets) {
      console.log(`${t.gate.padEnd(30)} ${t.inputs.join('  ') || '(no JSON input)'}`);
    }
    return;
  }

  console.log('mutation-check: a gate that passes on corrupted data is not a gate');
  console.log('');
  const results = [];

  for (const { gate, inputs } of targets) {
    // These refuse to run without the live cifi-tools bundle and exit 2 saying so. That is correct
    // behaviour, not a broken gate -- the first version of this harness ran them bare and reported
    // six healthy gates as BROKEN.
    if (NEEDS_BUNDLE.has(gate)) {
      results.push({ gate, status: 'NEEDS-INPUT', detail: 'requires --bundle=<live bundle>' });
      console.log(`NEEDS-ARG  ${gate.padEnd(30)} requires the live bundle; not mutable here`);
      continue;
    }
    if (!inputs.length) {
      results.push({ gate, status: 'UNMUTATED', detail: 'no JSON input to corrupt' });
      console.log(`UNMUTATED  ${gate.padEnd(30)} no JSON input to corrupt`);
      continue;
    }

    // Baseline: the gate must PASS on clean data, or a "detection" proves nothing.
    const base = runGate(gate);
    if (base.code !== 0) {
      results.push({ gate, status: 'ALREADY-FAILING', detail: `exits ${base.code} on clean data` });
      console.log(`BROKEN     ${gate.padEnd(30)} already fails on clean data (exit ${base.code})`);
      continue;
    }
    if (base.skipped) {
      results.push({ gate, status: 'SKIPS', detail: 'skips on clean data (missing input)' });
      console.log(`SKIPS      ${gate.padEnd(30)} skips for a missing input -- liveness unproven`);
      continue;
    }

    let detected = null;
    let tried = 0;
    outer:
    for (const rel of inputs) {
      const abs = path.join(ROOT, rel);
      const isJs = abs.endsWith('.js');
      let variants;
      const original = fs.readFileSync(abs);
      const originalSha = sha(abs);
      if (isJs) {
        variants = jsMutations(original.toString('utf8')).map((v) => ({ what: v.what, text: v.text }));
      } else {
        let json;
        try { json = JSON.parse(original.toString('utf8')); } catch { continue; }
        variants = mutations(json).map((v) => ({ what: v.what, text: JSON.stringify(v.data, null, 2) }));
      }

      for (const mut of variants) {
        tried++;
        try {
          fs.writeFileSync(abs, mut.text);
          const r = runGate(gate);
          // A crash is not a detection: mutating a value must make the gate REPORT a mismatch, not
          // blow up. A killed (timed-out) run proves nothing either.
          if (r.code !== 0 && !r.killed) { detected = `${path.basename(rel)}: ${mut.what}`; }
        } finally {
          // RESTORE, AND PROVE IT. Leaving reference data corrupted would be far worse than the
          // defect being hunted, so the hash is checked and a mismatch aborts everything.
          fs.writeFileSync(abs, original);
          if (sha(abs) !== originalSha) {
            console.error(`\nFATAL: could not restore ${rel} -- repository data may be damaged.`);
            process.exit(2);
          }
        }
        if (detected) break outer;
      }
    }

    if (detected) {
      results.push({ gate, status: 'DETECTED', detail: detected });
      console.log(`DETECTED   ${gate.padEnd(30)} ${detected}`);
    } else if (REPORTS.has(gate)) {
      // Expected: a report exits 0 by design. Recorded so the list stays visible rather than
      // quietly excluded -- if one of these ever SHOULD be a gate, it is here to be reconsidered.
      results.push({ gate, status: 'REPORT', detail: `exits 0 by design (${tried} corruptions ignored)` });
      console.log(`REPORT     ${gate.padEnd(30)} exits 0 by design; ${tried} corruption(s) ignored, as declared`);
    } else {
      // DATA mutation cannot probe a BEHAVIOUR gate. path-abort-test asserts that closing a modal
      // stops work; no value in hunterDefs.js can make that fail. Calling it BLIND would accuse a
      // working gate, so the honest label is that this bench could not prove it either way -- and
      // it stays on the list until something does.
      const onlyDefs = inputs.every((i) => i.endsWith('hunterDefs.js'));
      results.push({
        gate,
        status: 'UNPROVEN',
        detail: `passed all ${tried} data corruption(s)`
          + (onlyDefs ? '; likely a behaviour gate needing a behavioural probe' : ''),
      });
      console.log(`UNPROVEN   ${gate.padEnd(30)} survived ${tried} data corruption(s) of `
        + `${inputs.map((i) => path.basename(i)).join(', ')}`
        + (onlyDefs ? '  (behaviour gate?)' : ''));
    }
  }

  const by = (s) => results.filter((r) => r.status === s);
  console.log('');
  const proven = by('DETECTED').length;
  const unproven = by('UNPROVEN').length + by('UNMUTATED').length;
  console.log(`${proven} PROVEN LIVE, ${unproven} unproven, ${by('REPORT').length} reports, `
    + `${by('NEEDS-INPUT').length} need an argument, ${by('SKIPS').length} skipping, `
    + `${by('ALREADY-FAILING').length} broken (of ${results.length})`);
  if (by('ALREADY-FAILING').length) {
    console.log('');
    console.log('BROKEN -- these fail on clean data and must be fixed:');
    for (const r of by('ALREADY-FAILING')) console.log(`  ${r.gate}: ${r.detail}`);
  }
  if (unproven) {
    console.log('');
    console.log('UNPROVEN -- data mutation could not demonstrate these detect a fault.');
    console.log('Each needs either a mutable input or a behavioural probe; none is excused:');
    for (const r of by('UNPROVEN')) console.log(`  ${r.gate}: ${r.detail}`);
    for (const r of by('UNMUTATED')) console.log(`  ${r.gate}: no corruptible input found`);
  }
  // Only a gate that FAILS on clean data breaks the build here. "Unproven" is a to-do the audit
  // tracks, not a regression -- but it is printed every run so it cannot be forgotten.
  process.exitCode = by('ALREADY-FAILING').length ? 1 : 0;
})();
