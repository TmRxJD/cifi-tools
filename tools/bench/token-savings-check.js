#!/usr/bin/env node
// THIS IS A REPORT, NOT A GATE: it prints measurements and always exits 0.
//
// Measures the token-savings claims made for the 2026-09-13 context-efficiency changes:
//   1. CLAUDE.md -> skills split (subagent dispatch overhead)
//   2. .claude/hooks/filter-bench-output.js (bench-suite output volume)
//
// METHOD: no tokenizer library is installed (checked: gpt-tokenizer, js-tiktoken, tiktoken
// all absent), so token counts here are ESTIMATES via chars/4 -- a standard rough-equivalence
// for English text and code with Claude's tokenizer. This is stated so the numbers are read
// as "roughly N thousand tokens", not exact. The comparison is still valid because the SAME
// estimator is applied to both sides of every before/after pair -- the ratio is what matters,
// and a systematic estimator error cancels out of a ratio almost entirely.
//
// Run: node tools/bench/token-savings-check.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const estTokens = (str) => Math.round(str.length / 4);
const fmt = (n) => n.toLocaleString();

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function gitShow(rev, file) {
  return execSync(`git show ${rev}:${file}`, { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
}

// -------------------------------------------------------------------------
// 1. CLAUDE.md -> skills split: per-dispatch cost for a custom subagent
// -------------------------------------------------------------------------
section('1. Subagent dispatch overhead (CLAUDE.md + skills)');

const PRE_SPLIT_REV = 'd711483'; // last commit before the CLAUDE.md/skills split
const oldClaudeMd = gitShow(PRE_SPLIT_REV, 'CLAUDE.md');
const newClaudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');

const skillDir = path.join(ROOT, '.claude', 'skills');
const skills = fs.existsSync(skillDir) ? fs.readdirSync(skillDir) : [];
const skillSizes = {};
for (const name of skills) {
  const skillMd = path.join(skillDir, name, 'SKILL.md');
  const refMd = path.join(skillDir, name, 'reference.md');
  const skillTokens = fs.existsSync(skillMd) ? estTokens(fs.readFileSync(skillMd, 'utf8')) : 0;
  const refTokens = fs.existsSync(refMd) ? estTokens(fs.readFileSync(refMd, 'utf8')) : 0;
  skillSizes[name] = { skillTokens, refTokens, total: skillTokens + refTokens };
}

const oldTokens = estTokens(oldClaudeMd);
const newTokens = estTokens(newClaudeMd);

console.log(`Old CLAUDE.md (${PRE_SPLIT_REV}):  ~${fmt(oldTokens)} tokens (${oldClaudeMd.split('\n').length} lines)`);
console.log(`New CLAUDE.md (HEAD):          ~${fmt(newTokens)} tokens (${newClaudeMd.split('\n').length} lines)`);
console.log(`Baseline dispatch saving:       ~${fmt(oldTokens - newTokens)} tokens (${(100 * (1 - newTokens / oldTokens)).toFixed(1)}%) EVERY custom-subagent dispatch, whether or not a skill is needed`);
console.log('\nPer-skill cost IF that skill is loaded on top of the new baseline:');
for (const [name, sz] of Object.entries(skillSizes)) {
  console.log(`  ${name.padEnd(24)} +${fmt(sz.total)} tokens (frontmatter ${sz.skillTokens} + reference ${sz.refTokens})`);
}
const worstCaseAllSkills = newTokens + Object.values(skillSizes).reduce((a, s) => a + s.total, 0);
const largestSingleSkill = Math.max(...Object.values(skillSizes).map((s) => s.total));
console.log(`\nWorst case (new baseline + ALL ${skills.length} skills loaded): ~${fmt(worstCaseAllSkills)} tokens`);
console.log(`  vs old baseline always paying:                 ~${fmt(oldTokens)} tokens`);
console.log(`  -> loading every skill at once is ${worstCaseAllSkills < oldTokens ? 'still cheaper' : 'MORE EXPENSIVE -- regression'} than the pre-split file (rare in practice -- see below)`);
console.log(`\nRealistic single-skill case (the common one): baseline + largest single skill = ~${fmt(newTokens + largestSingleSkill)} tokens`);
console.log(`  vs old baseline always paying:                                                ~${fmt(oldTokens)} tokens`);
console.log(`  -> saving even in the worst SINGLE-skill case: ~${fmt(oldTokens - (newTokens + largestSingleSkill))} tokens (${(100 * (1 - (newTokens + largestSingleSkill) / oldTokens)).toFixed(1)}%)`);
console.log('\nMore, smaller skills lower this worst-single-skill number (finer topic boundaries mean');
console.log('fewer unrelated bullets get dragged in with the one you actually need).');

// -------------------------------------------------------------------------
// 2. Bench-output filter hook: tokens saved per gate-suite run
// -------------------------------------------------------------------------
section('2. Bench-output filter hook (tools/bench/all.js)');

let rawOutput;
try {
  rawOutput = execSync('node tools/bench/all.js', { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
} catch (e) {
  // all.js exits 1 if any gate fails; stdout is still on e.stdout
  rawOutput = (e.stdout || '').toString();
}
const rawTokens = estTokens(rawOutput);

const cleanExit = /^0 (?:build|gate)|passed, 0 failed/.test(rawOutput) || !/FAIL/.test(rawOutput);
let filteredOutput;
if (/FAIL/.test(rawOutput)) {
  filteredOutput = rawOutput; // hook passes through unfiltered on any failure -- by design
} else {
  filteredOutput = rawOutput.split('\n').filter((l) => /FAIL|ERROR|SKIP|passed/.test(l)).join('\n');
}
const filteredTokens = estTokens(filteredOutput);

console.log(`Raw output:      ~${fmt(rawTokens)} tokens (${rawOutput.split('\n').length} lines)`);
console.log(`Hook-filtered:   ~${fmt(filteredTokens)} tokens (${filteredOutput.split('\n').length} lines)`);
if (/FAIL/.test(rawOutput)) {
  console.log('(This run has a FAILING gate, so the hook passes output through UNFILTERED by design --');
  console.log(' the two numbers above are identical. This is the safety property, not a missed saving.');
  console.log(' Re-run after fixing the failure, or see the synthetic clean-run estimate below.)');
} else {
  console.log(`Saving on a clean run: ~${fmt(rawTokens - filteredTokens)} tokens (${(100 * (1 - filteredTokens / rawTokens)).toFixed(1)}%)`);
}

// Synthetic clean-run estimate: strip the one known failing gate's lines and re-filter,
// so the CLEAN-RUN saving is measurable even while companion-deps-check is red.
const syntheticClean = rawOutput
  .split('\n')
  .filter((l) => !/companion-deps-check/.test(l) && !/^failures:/.test(l) && !/extension\/ is up to date/.test(l) && !/the companion would break/.test(l))
  .join('\n');
const syntheticCleanTokens = estTokens(syntheticClean);
const syntheticFiltered = syntheticClean.split('\n').filter((l) => /FAIL|ERROR|SKIP|passed/.test(l)).join('\n');
const syntheticFilteredTokens = estTokens(syntheticFiltered);
console.log(`\nSynthetic clean-run estimate (current failure's lines removed first):`);
console.log(`  Raw:      ~${fmt(syntheticCleanTokens)} tokens`);
console.log(`  Filtered: ~${fmt(syntheticFilteredTokens)} tokens`);
console.log(`  Saving:   ~${fmt(syntheticCleanTokens - syntheticFilteredTokens)} tokens (${(100 * (1 - syntheticFilteredTokens / syntheticCleanTokens)).toFixed(1)}%) per clean gate run`);

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
section('Summary');
console.log(`CLAUDE.md split:     ~${fmt(oldTokens - newTokens)} tokens saved per custom-subagent dispatch (${(100 * (1 - newTokens / oldTokens)).toFixed(1)}%)`);
console.log(`Bench-output hook:   ~${(100 * (1 - syntheticFilteredTokens / syntheticCleanTokens)).toFixed(1)}% reduction on a clean gate run, ~0% (by design) on a run with a real failure`);
console.log('\nMethodology note: chars/4 token estimate, no tokenizer library available on this');
console.log('machine. Re-run this script any time to re-measure against the current tree.');
