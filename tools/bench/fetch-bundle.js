'use strict';
// FETCH THE LIVE cifi-tools BUNDLE, WHOLE, SO THE PARITY GATES CAN ACTUALLY RUN.
//
//   node tools/bench/fetch-bundle.js [--out=<path>]
//
// WHY THIS EXISTS. Eight gates compare this tool against the original -- gate-coverage,
// upgrade-item-parity, talent-attribute-parity, live-override-diff, inscryption-cost-check,
// base-stat-cost-check, relic-maxlevel-check, inscryption-maxlevel-check. They are the strongest
// correctness checks in the suite, because cifi-tools was built with the game's developers and for
// anything it models its bundle IS the verification.
//
// They had never run in a suite pass. Not because they were broken: because `--bundle=<path>`
// needs a file nobody had, assembling it by hand is fiddly, and so the default suite printed
// "8 bundle-comparison gate(s) not run" every time and everyone read past it. A gate that requires
// a manual step is a gate that does not run, which this repo has now learned three separate ways.
//
// THE SITE IS CODE-SPLIT, AND THAT HAS ALREADY CAUSED A WRONG REPORT. Fetching only
// `index-<hash>.js` misses the lazily-loaded pages (Trinkets, IAP, Ultima, DiamondSpecials), whose
// keys are then absent -- which produced a confident "we additionally expose 6 controls the
// original lacks" that was entirely false. So this follows every `assets/<Name>-<hash>.js`
// reference in the main bundle and concatenates the lot.
//
// The hash in the filename changes on every deploy, so the entry point is read out of the served
// HTML rather than pinned.

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const OUT = opt('out', path.join(__dirname, 'live-bundle.js'));
const SITE = opt('site', 'https://cifi-tools.com');

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

(async () => {
  console.log(`site: ${SITE}`);
  const html = await get(`${SITE}/`);
  const entry = (html.match(/assets\/index-[A-Za-z0-9_-]+\.js/) || [])[0];
  if (!entry) throw new Error('could not find assets/index-*.js in the served HTML');
  console.log(`entry: ${entry}`);

  const main = await get(`${SITE}/${entry}`);
  // Every lazily-loaded page the main bundle can pull in. Deduplicated because a chunk can be
  // referenced from several places, and fetching one twice would double-count its keys.
  const chunks = [...new Set((main.match(/assets\/[A-Za-z0-9_-]+\.js/g) || []))]
    .filter((c) => c !== entry);
  console.log(`chunks: ${chunks.length}`);

  const parts = [`/* ${entry} */\n${main}`];
  let failed = 0;
  for (const c of chunks) {
    try {
      parts.push(`\n/* ${c} */\n${await get(`${SITE}/${c}`)}`);
    } catch (e) {
      // Reported, never silent: a missing chunk means the comparison is over LESS than the whole
      // site, and a parity gate run against a partial bundle reports false gaps -- which is the
      // exact failure this file exists to prevent.
      failed++;
      console.log(`  WARN could not fetch ${c}: ${e.message}`);
    }
  }

  fs.writeFileSync(OUT, parts.join('\n'), 'utf8');
  const mb = (fs.statSync(OUT).size / 1e6).toFixed(2);
  console.log(`\nwrote ${OUT}  (${mb} MB, ${parts.length} file(s))`);
  if (failed) {
    console.log(`${failed} chunk(s) FAILED to download -- the parity gates will be comparing`);
    console.log('against an incomplete bundle and may report gaps that do not exist.');
    process.exit(1);
  }
  console.log('\nrun the parity gates with:');
  console.log(`  node tools/bench/all.js --bundle=${path.relative(process.cwd(), OUT)}`);
})().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1); });
