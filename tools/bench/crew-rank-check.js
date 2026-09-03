'use strict';
// The crew/rank composition the importer applies, checked against the game's own numbers.
//
// The game does NOT store crew or rank as a single total. From the recovered C# (FleetManager):
//
//   FinalCradleCrew = LM.LM240Bonus  + MM.Ship1CrewLevel + Market.FinalISFreeCradleCrew
//   FinalCradleRank = LM.LM239Bonus1 + MM.Ship1Rank      + Market.FinalISFreeCradleRanks
//                                                        + RL.FinalAllShipsRanksBonus
//
// with `FinalISFree<Ship>Crew = IS<n>Bonus * IS<n>Level` (MultiverseMarket) and both loop-mod
// terms linear in `LM<n>Level * LM<n>BonusExponent1` (LoopModifiers).
//
// `Ship{n}CrewLevel` and `Ship{n}Rank` are therefore only what the player BOUGHT. Importing them
// raw understated crew, and crew multiplies every install node's bonus linearly -- on the
// reference save Cradle went 600 -> 680, i.e. every Cradle install bonus was ~13% low.
//
// This pins the two loop-mod coefficients against tools/reference/loop-mods.json, which is
// extracted straight from the game's scene data, so a hardcoded constant in shipSchema.js cannot
// drift from the source it came from.
//
//   node tools/bench/crew-rank-check.js

const H = require('./harness.js');
const LOOP_MODS = require('../reference/loop-mods.json').loopMods;

const sb = H.browserSandbox();
let failures = 0;

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) { console.log(`FAIL  ${name}\n        ${problem}`); failures++; }
    else console.log(`pass  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n        threw: ${err.stack.split('\n').slice(0, 2).join(' | ')}`);
    failures++;
  }
}

/** loop-mods.json stores some values as BigDouble {mantissa, exponent}. */
function num(v) {
  if (v && typeof v === 'object' && 'mantissa' in v) return v.mantissa * 10 ** v.exponent;
  return Number(v);
}

// The importer's constants are module-private, so drive the real mapper with synthetic saves and
// read the composition back out of its own reported breakdown. That tests the SHIPPED path.
function shipsFrom(extra) {
  return sb.mapCifiSaveToShips(Object.assign({
    Ship1Unlocked: true, Ship1CrewLevel: 100, Ship1Rank: 10,
  }, extra));
}

check('loop-mod crew coefficient matches the game scene data (LM240BonusExponent1)', () => {
  const expected = num(LOOP_MODS['240'].BonusExponent1);
  const base = shipsFrom({})[1].crewLevel;
  const withLm = shipsFrom({ LM240Level: 5 })[1].crewLevel;
  const perLevel = (withLm - base) / 5;
  return perLevel === expected ? null
    : `importer adds ${perLevel} crew per LM240 level, scene data says ${expected}`;
});

check('loop-mod rank coefficient matches the game scene data (LM239BonusExponent1)', () => {
  const expected = num(LOOP_MODS['239'].BonusExponent1);
  const base = shipsFrom({})[1].rank;
  const withLm = shipsFrom({ LM239Level: 5 })[1].rank;
  const perLevel = (withLm - base) / 5;
  return perLevel === expected ? null
    : `importer adds ${perLevel} ranks per LM239 level, scene data says ${expected}`;
});

check('free-inscryption crew is 8 per level and rank 1 per level', () => {
  // From MultiverseMarket's FinalISFree<Ship>Crew = IS49Bonus * IS49Level, cross-checked against
  // the grant table this repo modelled independently before the inputs were simplified.
  const base = shipsFrom({});
  const withIs = shipsFrom({ IS49Level: 10, IS48Level: 8 });
  const crewPer = (withIs[1].crewLevel - base[1].crewLevel) / 10;
  const rankPer = (withIs[1].rank - base[1].rank) / 8;
  if (crewPer !== 8) return `free crew is ${crewPer} per IS49 level, expected 8`;
  if (rankPer !== 1) return `free ranks is ${rankPer} per IS48 level, expected 1`;
  return null;
});

check('purchased and free are reported separately, and they sum to the total', () => {
  const s = shipsFrom({ IS49Level: 10, IS48Level: 8, LM240Level: 2, LM239Level: 3 })[1];
  if (s.purchasedCrewLevel !== 100) return `purchasedCrewLevel ${s.purchasedCrewLevel}, expected 100`;
  if (s.purchasedRank !== 10) return `purchasedRank ${s.purchasedRank}, expected 10`;
  if (s.purchasedCrewLevel + s.freeCrew !== s.crewLevel) {
    return `crew ${s.purchasedCrewLevel} + ${s.freeCrew} != ${s.crewLevel}`;
  }
  if (s.purchasedRank + s.freeRanks !== s.rank) {
    return `rank ${s.purchasedRank} + ${s.freeRanks} != ${s.rank}`;
  }
  return null;
});

check('a save with the unmodelled all-ships ranks research is reported, not silently wrong', () => {
  if (sb.unmodelledCrewRankTerms({}).length !== 0) return 'a clean save reported a missing term';
  const terms = sb.unmodelledCrewRankTerms({ RU83Level: 2 });
  return terms.length ? null : 'RU83 owned but nothing reported';
});

console.log(`\n${failures ? `${failures} FAILED` : 'crew/rank composition matches the game'}`);
process.exit(failures ? 1 : 0);
