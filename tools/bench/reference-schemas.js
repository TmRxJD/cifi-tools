'use strict';
// Zod schemas for the game-derived reference files under tools/reference/.
//
// WHY ZOD, AND WHERE IT RUNS. The shipped webapp deliberately has no build step -- it loads plain
// files through <script> tags -- so zod is a DEV dependency used by the Node benches only. Nothing
// here reaches the browser. That keeps the property this project values (no bundler) while still
// getting real schema enforcement exactly where drift has actually bitten: the extracted reference
// files that a dozen benches read.
//
// The failure mode these prevent is specific and has happened repeatedly during this work: an
// extractor changes shape, a consumer reads `undefined`, and the bench PASSES because `undefined`
// compares equal to the other side's `undefined`. A silently empty reference looks exactly like a
// clean run. Parsing every file before use turns that into a loud failure at a named path.
//
// Each schema is `.strict()` where the shape is fully known, so an ADDED field also fails -- a new
// key usually means the extractor learned something the consumers have not been taught to read.

const { z } = require('zod');

// Provenance every extracted file carries: what it came from, and which build.
const meta = {
  _source: z.string().min(1),
  _meaning: z.string().min(1).optional(),
  _game: z.string().min(1),
};
const numericKey = z.string().regex(/^\d+$/, 'expected a numeric id as the key');

// A record that must not be EMPTY. This is the whole point of parsing these files: an extractor
// that silently produces `{}` is the exact failure mode zod is here to catch, and a bare
// z.record() accepts it happily -- a first pass at these schemas did, and the negative control
// for "silently empty payload" passed when it should have failed.
const nonEmptyRecord = (key, value) => z.record(key, value)
  .refine((o) => Object.keys(o).length > 0, { message: 'is empty -- the extractor produced nothing' });

const schemas = {
  'badge-map.json': z.object({
    ...meta,
    // category -> the badges EVERY node of that category multiplies in
    perCategory: nonEmptyRecord(z.string(), z.array(z.string().regex(/^(Dark)?Badge\d+$/))),
    values: nonEmptyRecord(z.string(), z.number().positive()),
  }).strict(),

  'node-factors.json': z.object({
    ...meta,
    factors: nonEmptyRecord(z.string(), nonEmptyRecord(numericKey, z.array(z.string().min(1)))),
  }).strict(),

  'ship-node-counters.json': z.object({
    ...meta,
    counters: nonEmptyRecord(z.string(), nonEmptyRecord(numericKey, z.array(z.string().min(1)))),
  }).strict(),

  'ship-node-gates.json': z.object({
    ...meta,
    _semanticsFrom: z.string().min(1),
    categories: nonEmptyRecord(z.string(), nonEmptyRecord(numericKey, z.object({
      // a requirement of 0 means "open from the start"; a cap must be a positive count
      requirement: z.number().nonnegative(),
      maxLevel: z.number().int().nonnegative(),
    }).strict())),
  }).strict(),

  'ship-node-names.json': z.object({
    ...meta,
    panels: nonEmptyRecord(z.string(), nonEmptyRecord(numericKey, z.object({
      Title: z.string().min(1),
      LevelText: z.string().optional(),
      unlockText: z.string().optional(),
    }).passthrough())),
  }).strict(),

  'uniform-node-terms.json': z.object({
    ...meta,
    terms: nonEmptyRecord(z.string(), z.object({
      type: z.string().min(1),
      levelField: z.string().min(1),
      found: z.boolean(),
      // null is a real, meaningful value here: "no level gate found, so undeterminable" -- and it
      // must never be collapsed into false. See extract-uniform-terms.py.
      inertWhenUnowned: z.boolean().nullable(),
    }).strict()),
  }).strict(),

  'gear-install-map.json': z.object({
    ...meta,
    mappings: z.array(z.object({
      category: z.string().min(1),
      node: z.number().int().positive(),
      color: z.string().min(1),
      item: z.number().int().positive(),
      bonus: z.union([z.literal(1), z.literal(2)]),
    }).strict()).min(1),
  }).strict(),

  'gear-names.json': z.object({
    ...meta,
    rows: z.array(z.object({
      index: z.number().int().nonnegative(),
      name: z.string().min(1),
      gemGate: z.string().nullable(),
      quality: z.number().int().positive().nullable(),
      unlockText: z.string().optional(),
    }).strict()).min(1),
  }).strict(),

  'gear-set-bonus-map.json': z.object({
    _source: z.string().min(1),
    _meaning: z.string().min(1),
    // this file's two halves can legitimately come from different builds, so it records both
    _mappingFrom: z.string().min(1),
    _valuesFrom: z.string().min(1),
    unusedBonuses: z.array(z.object({
      name: z.string().min(1),
      value: z.number(),
    }).strict()),
    mappings: z.array(z.object({
      color: z.string().min(1),
      index: z.number().int().positive(),
      resource: z.string().min(1),
      resourceLabel: z.string().min(1),
      value: z.number(),
    }).strict()).min(1),
  }).strict(),
};

module.exports = { schemas, meta, numericKey };
