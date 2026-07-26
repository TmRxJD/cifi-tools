#!/usr/bin/env node
// MCP server exposing calculation-accuracy comparison tools between the local HunterSim
// clone (webapp/) and the live cifi-tools.com site. See ../compare-mcp/README.md.
//
// Why this is cheap: both evaluators run the SAME wasm binary (release.wasm, extracted
// verbatim from the live bundle -- see webapp/public/hunterSimBrowser.js's header comment),
// so a mismatch always means the STATE fed into it differs, never a reimplemented-formula
// bug. compare_builds returns only a small numeric diff, never DOM/page content, so a
// tuning session costs a handful of tool calls instead of scraping/re-scraping full pages.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { evaluateOnClone } from './clone-eval.mjs';
import { evaluateOnLiveSite } from './live-eval.mjs';
import { getHunterDefs } from './build-code.mjs';

const HUNTER_ENUM = z.enum(['borge', 'ozzy', 'knox']);
const TEST_BUILD_SHAPE = {
  level: z.number().int().min(1).describe('Hunter level'),
  talents: z.record(z.string(), z.number()).default({}).describe('talentId -> level, e.g. {"echo": 1}'),
  attributes: z.record(z.string(), z.number()).default({}).describe('attributeId -> level, e.g. {"snek": 2}'),
  baseStats: z.record(z.string(), z.number()).default({}).describe(
    'Explicit base stat values (hp/atk/regen/dr/evade-or-block/effect/critchance-or-multichance/'
    + 'critpower-or-multipower/atkspeed, +stage for Knox) -- see hunterDefs.js baseStatKeys per '
    + 'hunter. These are forced overrides on both sides so the comparison never depends on '
    + 'either environment\'s ambient/default stats.',
  ),
  globalUpgrades: z.record(z.string(), z.number()).default({}).describe(
    'Flat "category.field" -> level map, e.g. {"relics.r4": 13, "inscryptions.i3": 8}. Only '
    + 'keys present in that hunter\'s build-code param list (webapp/public/buildCode.js '
    + 'CODE_PARAMS) actually affect the live-site side; everything else defaults to 0 on both sides.',
  ),
};

function summarize(hunter, live, clone) {
  const cloneLootScore = clone.lootPerMin;
  const fields = [
    { key: 'lootScore', live: live.lootScore, clone: cloneLootScore },
    { key: 'avgStage', live: live.avgStage, clone: clone.avgStage },
    { key: 'avgTimeMinutes', live: live.avgTimeMinutes, clone: clone.avgTime },
    { key: 'minStage', live: live.minStage, clone: clone.minStage },
    { key: 'maxStage', live: live.maxStage, clone: clone.maxStage },
  ];
  // 1000-iteration Monte Carlo runs on either side never come out bit-identical -- flag only
  // deltas outside normal sampling noise (~2%) as a real mismatch worth investigating.
  const diffs = fields.map((f) => {
    if (f.live == null || f.clone == null) return { ...f, deltaPct: null, flagged: f.live !== f.clone };
    const base = Math.max(Math.abs(f.live), Math.abs(f.clone), 1e-9);
    const deltaPct = ((f.clone - f.live) / base) * 100;
    return { ...f, deltaPct: Number(deltaPct.toFixed(2)), flagged: Math.abs(deltaPct) > 2 };
  });
  return { hunter, diffs, anyFlagged: diffs.some((d) => d.flagged), liveBuildCode: live.buildCode };
}

const server = new McpServer({ name: 'cifi-compare', version: '1.0.0' });

server.registerTool(
  'get_clone_stats',
  {
    title: 'Get local-clone sim stats',
    description: 'Runs the given build through the LOCAL HunterSim clone\'s own wasm evaluator (starts the local webapp server if needed) and returns Loot Score/Stage/Time stats.',
    inputSchema: { hunter: HUNTER_ENUM, ...TEST_BUILD_SHAPE, iterations: z.number().int().min(1).max(20000).default(1000) },
  },
  async ({ hunter, iterations, ...testBuild }) => {
    const result = await evaluateOnClone(hunter, testBuild, iterations);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  'get_live_stats',
  {
    title: 'Get live cifi-tools.com sim stats',
    description: 'Generates a real build-share code for the given build, imports it into a fresh guest session on the live cifi-tools.com site, and reads back its computed Loot Score/Stage/Time stats.',
    inputSchema: { hunter: HUNTER_ENUM, ...TEST_BUILD_SHAPE },
  },
  async ({ hunter, ...testBuild }) => {
    const result = await evaluateOnLiveSite(hunter, testBuild);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  'compare_builds',
  {
    title: 'Compare clone vs live for one build',
    description: 'Runs the same build through both the local clone and the live site, and returns a small numeric diff (percent deltas per stat, flagged if outside ~2% Monte Carlo noise). This is the main entry point for sanity-checking calculation accuracy -- it costs one small JSON reply instead of two full page fetches.',
    inputSchema: { hunter: HUNTER_ENUM, ...TEST_BUILD_SHAPE, iterations: z.number().int().min(1).max(20000).default(1000) },
  },
  async ({ hunter, iterations, ...testBuild }) => {
    const [live, clone] = await Promise.all([
      evaluateOnLiveSite(hunter, testBuild),
      evaluateOnClone(hunter, testBuild, iterations),
    ]);
    const summary = summarize(hunter, live, clone);
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  },
);

server.registerTool(
  'list_hunter_defs',
  {
    title: 'List talent/attribute ids per hunter',
    description: 'Returns each hunter\'s talent and attribute id list with maxLevel, so build inputs to the other tools use valid ids/levels.',
    inputSchema: {},
  },
  async () => {
    const defs = await getHunterDefs();
    const slim = {};
    for (const [hunter, hd] of Object.entries(defs)) {
      slim[hunter] = {
        talents: hd.talents.map((t) => ({ id: t.id, label: t.label, maxLevel: t.maxLevel })),
        attributes: hd.attributes.map((a) => ({ id: a.id, label: a.label, maxLevel: a.maxLevel })),
        baseStatKeys: hd.baseStatKeys,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(slim) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
