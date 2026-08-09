'use strict';
const H = require('./harness.js');
(async () => {
  const [hunter, set, idx] = [process.argv[2], process.argv[3], Number(process.argv[4])];
  const fx = H.loadKnownBuilds()[hunter].find((b) => b.set === set && b.index === idx);
  if (!fx) throw new Error('fixture not found');
  const b = await H.parseBuildCode(fx.code);
  const cfg = H.cfgForImport(hunter, b);
  const d = H.hunterDefs()[hunter];
  console.log(`${hunter}/${set}#${idx}  fixture level ${fx.level}  note: ${fx.note || '-'}`);
  console.log('decoded level  :', b.level);
  console.log('talents        :', JSON.stringify(b.talents));
  console.log('caps           :', JSON.stringify(Object.fromEntries(d.talents.map((t) => [t.id, t.maxLevel]))));
  console.log('cfg TALENTS    :', cfg.TALENTS.map((t) => t.id).join(','));
  console.log('talent budget  :', cfg.TALENT_BUDGET, ' spend:', H.Space.costOf(d.talents, b.talents));
  for (const t of d.talents) {
    const lvl = b.talents[t.id] || 0;
    if (lvl > t.maxLevel) console.log(`  !! OVER CAP: ${t.id}=${lvl} > ${t.maxLevel}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
