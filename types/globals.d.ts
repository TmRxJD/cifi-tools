// The cross-file global surface.
//
// This app has no bundler: modules communicate by assigning to `window.*` in a fixed <script>
// order (see index.html). That works, but it is invisible to tooling -- an editor cannot tell
// you that `AllocSpace.costOf` takes (defs, alloc) and not (alloc, defs), and nothing catches a
// renamed field until it throws in the browser. These declarations give the type checker (and
// any AI assistant reading the repo) the contract.
//
// SCOPE: the pure logic modules, whose signatures were read directly off the implementations
// rather than guessed. The page-rendering globals (renderFleetPage, openGearEffectivePath, ...)
// are intentionally NOT declared yet -- see the note at the bottom.
//
// Keep in sync with the implementation. If a signature here disagrees with the code, the code
// wins and this file is the bug.

// ---------------------------------------------------------------------------------------
// Game data -- hunterDefs.js
// ---------------------------------------------------------------------------------------

type HunterId = 'borge' | 'ozzy' | 'knox';

/** A talent or attribute node. Talents have cost 1 and no gating. */
interface AllocNode {
  id: string;
  label?: string;
  /** Point cost per level. Absent means 1. */
  cost?: number;
  /** May be Infinity for uncapped nodes (e.g. Soul Of Ares). */
  maxLevel: number;
  /** Advanced talents stay hidden until unlocked -- see shouldShowAdvancedTalents(). */
  advanced?: boolean;
}

interface UpgradeItem { id: string; label: string; maxLevel: number; temporary?: boolean }
interface UpgradeCategory { label: string; items: UpgradeItem[] }

interface HunterDef {
  talents: AllocNode[];
  attributes: AllocNode[];
  /** attributeId -> ids that must each be > 0 before it is legal. */
  attributeDependencies: Record<string, string[]>;
  /** attributeId -> points that must be spent in strictly-lower-threshold nodes. 0 = ungated. */
  attributeMinValue: Record<string, number>;
  statCaps: Record<string, number>;
  baseStatKeys: string[];
  globalUpgrades: Record<string, UpgradeCategory>;
}

declare var HUNTER_DEFS: Record<HunterId, HunterDef>;
declare function talentBudgetForLevel(level: number): number;
declare function attributeBudgetForLevel(level: number): number;
declare function buildNestedUpgrades(flat: Record<string, number>): Record<string, Record<string, number>>;
declare function defaultGemState(): Record<string, GemTreeState>;

interface GemTreeState { level: number; nodes: boolean[]; upgrades: Record<string, number> }

// ---------------------------------------------------------------------------------------
// Allocation space -- optimizer/space.js
// ---------------------------------------------------------------------------------------

/** nodeId -> level. Missing keys read as 0 everywhere. */
type Allocation = Record<string, number>;

interface SupportSet { mask: number; minCost: number; ids: string[] }

interface AllocSpaceApi {
  /** Allocations may leave at most this many points idle; more is pruned as dominated. */
  readonly MAX_IDLE_POINTS: number;
  costOf(defs: AllocNode[], alloc: Allocation): number;
  pointsBelowThreshold(defs: AllocNode[], minVal: Record<string, number>, alloc: Allocation, threshold: number): number;
  /** Can this node take one MORE point? */
  isEligible(def: AllocNode, defs: AllocNode[], deps: Record<string, string[]>, minVal: Record<string, number>, alloc: Allocation): boolean;
  /** Is this node's CURRENT level legal? (Ignores maxLevel headroom.) */
  isHeld(def: AllocNode, defs: AllocNode[], deps: Record<string, string[]>, minVal: Record<string, number>, alloc: Allocation): boolean;
  isLegal(defs: AllocNode[], deps: Record<string, string[]>, minVal: Record<string, number>, alloc: Allocation, budget: number): boolean;
  /** Zeroes anything whose gate no longer holds, to a fixpoint. Mutates `alloc`. */
  clearInvalidDescendants(defs: AllocNode[], deps: Record<string, string[]>, minVal: Record<string, number>, alloc: Allocation): void;
  /** Every dependency-closed, affordable support set. Exhaustive. */
  enumerateSupports(defs: AllocNode[], deps: Record<string, string[]>, budget: number): SupportSet[];
  /** Deterministic full-budget fill over exactly `supportIds`. Null if unrealizable. */
  canonicalFill(defs: AllocNode[], deps: Record<string, string[]>, minVal: Record<string, number>, budget: number, supportIds: string[], openOnly?: boolean): Allocation | null;
  fillLeftover(defs: AllocNode[], deps: Record<string, string[]>, minVal: Record<string, number>, budget: number, alloc: Allocation): Allocation;
  /** Reduce to fit `budget`, then repair anything stranded. Mutates `alloc`. */
  trimToBudget(defs: AllocNode[], deps: Record<string, string[]>, minVal: Record<string, number>, budget: number, alloc: Allocation): Allocation;
  /** Move `amount` points from -> to. Null when illegal, dominated, or a no-op. */
  transfer(defs: AllocNode[], deps: Record<string, string[]>, minVal: Record<string, number>, budget: number, alloc: Allocation, fromId: string, toId: string, amount: number): Allocation | null;
  sameAlloc(defs: AllocNode[], a: Allocation, b: Allocation): boolean;
  signature(defs: AllocNode[], alloc: Allocation): string;
}

declare var AllocSpace: AllocSpaceApi;

// ---------------------------------------------------------------------------------------
// Optimizer -- optimizer/search.js and optimizer/runner.js
// ---------------------------------------------------------------------------------------

type OptimizeMode = 'loot' | 'push' | 'boss' | 'bossTimeless';

/** As built by app.js's cfgFor(). Feeds HunterSim.compileEvaluator plus the search. */
interface OptimizerConfig {
  hunter: HunterId;
  level: number;
  hunterStats: Record<string, number>;
  globalUpgrades: Record<string, Record<string, number>>;
  gemPlannerStore: { gemStates: Record<string, GemTreeState> };
  baseOverrides: Record<string, number>;
  TALENTS: AllocNode[];
  ATTRIBUTES: AllocNode[];
  ATTRIBUTE_DEPENDENCIES: Record<string, string[]>;
  ATTRIBUTE_MIN_VALUE: Record<string, number>;
  TALENT_BUDGET: number;
  ATTRIBUTE_BUDGET: number;
  currentTalents?: Allocation;
  currentAttrs?: Allocation;
}

interface AllocationPair { talentAlloc: Allocation; attrAlloc: Allocation }
interface ScoredAllocation extends AllocationPair { score: number }
interface BossMetadata { kill: number; hp: number; maxStage: number }
type ScoreBatch = number[] & { boss?: BossMetadata[]; telemetry?: Record<string, number> };

interface OptimizeProgress {
  phase: 'enumerate' | 'screen' | 'survey' | 'refine' | 'final' | 'done';
  done: number;
  total: number;
  evals: number;
}

interface OptimizeResult {
  diag?: Record<string, any>;
  best: ScoredAllocation | null;
  ranked: ScoredAllocation[];
  evals: number;
  cacheHits: number;
  notes: string[];
  cancelled: boolean;
  supportsEnumerated?: number;
  supportsRealizable?: number;
}
/** Diagnostic archive-only effort returns before final ranking and full-fidelity verification. */
interface ArchiveOnlyOptimizeResult {
  archiveOnly: true;
  best: ScoredAllocation;
  evals: number;
  notes: string[];
  diag: Record<string, unknown>;
}

interface OptimizeOptions {
  mode?: OptimizeMode;
  effort?: string | Record<string, unknown>;
  maxSeconds?: number;
  /** The ONLY I/O the search performs. Must be pure and deterministic. */
  scorer: (pairs: AllocationPair[], iterations: number) => Promise<ScoreBatch>;
  /**
   * A scorer bound to a DIFFERENT objective, for the cross-seed pass.
   *
   * REQUIRED whenever the mode declares `crossSeedFrom` (`loot` and `push` both do); optional
   * only for the boss modes, which cross-seed from nothing. It is not optional-with-a-fallback:
   * `optimize()` throws when a cross-seeding mode is given no factory, because silently skipping
   * the pass would make the answer depend on which caller invoked it.
   */
  scorerFor?: (mode: OptimizeMode) => Promise<OptimizeOptions['scorer']> | OptimizeOptions['scorer'];
  onProgress?: (p: OptimizeProgress) => void;
  shouldCancel?: () => boolean;
}

interface HunterOptimizerApi {
  readonly EFFORT_LEVELS: Record<string, { label: string; help: string; localOnly?: boolean }>;
  readonly DEFAULT_EFFORT: string;
  optimize(cfg: OptimizerConfig, options: OptimizeOptions): Promise<OptimizeResult | ArchiveOnlyOptimizeResult>;
  /** Coarse ranking fidelity. The one shared value -- do not introduce a second. */
  readonly SCREEN_ITERATIONS: number;
  /** Decision fidelity, matching what the build card displays. */
  readonly FINAL_ITERATIONS: number;
  readonly STEP_SIZES: number[];
  optimizeJointly(ctx: {score(pairs: AllocationPair[], iterations: number): Promise<ScoreBatch>; shouldCancel(): boolean; note(message: string): void}, cfg: OptimizerConfig,
    talents: Allocation, attributes: Allocation, startScore: number, stepSizes: number[], maxSweeps: number,
    pinnedAttrs?: string[], onFrac?: ((fraction: number) => void) | null, iterations?: number, maxRounds?: number,
    stopAfterSweep?: ((sweep: number) => boolean) | null): Promise<ScoredAllocation>;
}

declare var HunterOptimizer: HunterOptimizerApi;
declare var OptimizerObjective: typeof import('../webapp/public/optimizer/objective.js');

/** Browser entry point: stands up the worker pool and runs HunterOptimizer.optimize. */
declare function runOptimizer(
  cfg: OptimizerConfig,
  options?: { mode?: OptimizeMode; effort?: string; maxSeconds?: number; onProgress?: (p: OptimizeProgress) => void; shouldCancel?: () => boolean; poolSize?: number },
): Promise<OptimizeResult | ArchiveOnlyOptimizeResult | { best: null; ranked: ScoredAllocation[]; cancelled: true }>;

// ---------------------------------------------------------------------------------------
// Simulation -- hunterSimBrowser.js
// ---------------------------------------------------------------------------------------

/** As built by app.js's evalStateFor(). Feeds HunterSim.evaluate. */
interface EvalState {
  level: number;
  iterations?: number;
  hunterStats: Record<string, number>;
  talents: Allocation;
  attributes: Allocation;
  overrides: Record<string, number>;
  upgrades: Record<string, Record<string, number>>;
  gemPlannerStore: { gemStates: Record<string, GemTreeState> };
}

interface EvalResult {
  lootPerMin: number;
  avgStage?: number;
  avgTime?: number;
  minStage?: number;
  maxStage?: number;
  bossHpPercent?: number;
  bossKillRate?: number;
  mat1?: number;
  mat2?: number;
  mat3?: number;
  xp?: number;
}

interface DetailedEvalResult extends EvalResult {
  finalStats: Record<string, number>;
  stageDistribution: Array<{ stage: number; count: number }>;
}

/** Overrides cfg.hunterStats per call; keys opted in via cfg.STAT_KEYS. */
type EvalFast = (
  talentAlloc: Allocation,
  attrAlloc: Allocation,
  iterations?: number,
  statAlloc?: Record<string, number>,
  inscryptionAlloc?: Record<string, number>,
) => Promise<EvalResult>;

interface HunterSimApi {
  engineSource(): string;
  expectInjectedWasm(): void;
  setWasmModule(module: WebAssembly.Module): void;
  failWasmModule(error: unknown): void;
  loadWasmModule(): Promise<WebAssembly.Module>;
  createNativeEvaluator(options?: { onerror?: (event: ErrorEvent) => void }): NativeEvaluator;
  readonly POST_SIM_XP_MULTIPLIERS: Array<{key: string; perLevel: number}>;
  evaluate(hunter: HunterId, state: EvalState): Promise<EvalResult>;
  evaluateDetailed(hunter: HunterId, state: EvalState): Promise<DetailedEvalResult>;
  buildArgs(hunter: HunterId, state: EvalState): Promise<number[]>;
  resolveParam(name: string, state: Partial<EvalState>): number;
  compileEvaluator(hunter: HunterId, cfg: OptimizerConfig & { STAT_KEYS?: string[]; INSCRYPTION_PARAMS?: string[] }, timings?: { argumentMs:number; instantiateMs:number; simulateMs:number; extractMs:number } | null): Promise<EvalFast>;
  loadParams(): Promise<Record<HunterId, string[]>>;
  loadWasm(): Promise<WebAssembly.Exports>;
  clearCache(): void;
  /**
   * THE cancellation primitive for long-running sim work (purchase paths, income rates).
   * Throws an Error whose `name` is `ABORTED` when the signal is already aborted.
   */
  throwIfAborted(signal?: AbortSignal | null): void;
  isAbort(err: unknown): boolean;
  readonly ABORTED: string;
}

interface NativeEvaluator {
  evaluate(hunter: HunterId, build: {level: number; talents: Allocation; attributes: Allocation; overrides: Record<string, number>}, store: {
    hunterStats: Partial<Record<HunterId, Record<string, number>>>;
    upgrades: Record<string, Record<string, number>>;
    hunterIterations: Partial<Record<HunterId, number>>;
    hunterSeedSettings: Record<string, unknown>;
    gemPlannerStore: OptimizerConfig['gemPlannerStore'];
  }): Promise<EvalResult & {stats: string}>;
  inFlight(): number;
  terminate(error: unknown): void;
}
declare var HunterSim: HunterSimApi;

/** Set by a Worker before importing hunterSimBrowser.js so relative asset fetches resolve. */
declare var HUNTERSIM_ASSET_BASE: string | undefined;
declare var HUNTERSIM_EMBEDDED: boolean | undefined;
declare var HUNTERSIM_WORKER_URL: string | undefined;

// ---------------------------------------------------------------------------------------
// Persisted store -- storeSchema.js
// ---------------------------------------------------------------------------------------

interface StoredBuild {
  id: string | null;
  name: string;
  level: number;
  talents: Allocation;
  attributes: Allocation;
  categoryId: string;
  overrides: Record<string, number>;
}

interface HunterStoreSlice { hunterStats: Record<string, number>; builds: StoredBuild[] }

interface SchemaFieldSpec { make: () => unknown; deep?: boolean }

interface StoreSchemaApi {
  readonly HUNTERS: HunterId[];
  readonly SCHEMA: Record<string, SchemaFieldSpec>;
  readonly RETIRED_KEYS: string[];
  seedHunterStats(hunter: HunterId): Record<string, number>;
  defaultImportPrefs(): Record<string, unknown>;
  defaultLoadoutTabs(): Record<string, unknown>;
  /** A brand new store: the schema materialized. */
  freshStore(): Record<string, any>;
  /** Deep-fill a loaded store to the current schema. Mutates and reports what changed. */
  migrateStore(parsed: Record<string, any>): { store: Record<string, any>; added: string[]; removed: string[]; changed: boolean };
  /** Human-readable invariant violations; empty array means clean. */
  validateStore(store: Record<string, any>): string[];
  validateAllocation(hunter: HunterId, build: StoredBuild, where: string): string[];
}

declare var StoreSchema: StoreSchemaApi;

// ---------------------------------------------------------------------------------------
// Build share codes -- buildCode.js
// ---------------------------------------------------------------------------------------

interface ParsedBuild {
  hunterId: HunterId;
  hunter: HunterId;
  name: string;
  level: number;
  talents: Allocation;
  attributes: Allocation;
  /** Base stats, keyed by bare stat name. */
  overrides: Record<string, number>;
  /** Full param names, e.g. "upgrades.gadgets.anchor". */
  upgradeOverrides: Record<string, number>;
  carriedUpgradeKeys: string[];
}

declare function parseBuildCode(code: string): Promise<ParsedBuild | null>;
declare function generateBuildCode(
  hunter: HunterId,
  buildData: Partial<StoredBuild>,
  hunterStats: Record<string, number>,
  globalUpgrades: Record<string, number>,
  gems: Record<string, GemTreeState>,
): Promise<string>;
declare function isPureLootOverrideKey(key: string): boolean;

// ---------------------------------------------------------------------------------------
// Purchase path -- hunterStatPathBrowser.js
// ---------------------------------------------------------------------------------------

interface PurchaseStep {
  kind: 'stat' | 'inscryption';
  key: string;
  label?: string;
  level: number;
  cost: number;
  resource: string;
}

declare function resourcesFor(hunter: HunterId, includeInscriptions: boolean): string[];
declare function greedyPurchasePath(
  hunter: HunterId,
  cfg: Record<string, any>,
  targetSteps: number,
  includeInscriptions: boolean,
  onProgress?: (resource: string, done: number, total: number) => void,
): Promise<{ columns: Record<string, { steps: PurchaseStep[]; finalSim: EvalResult }> }>;

// ---------------------------------------------------------------------------------------
// The same names as properties of window / globalThis
// ---------------------------------------------------------------------------------------
// Runtime properties use `declare var` so they also exist on typeof globalThis; Window merges
// below describe the same API when a browser module receives window explicitly.

interface HunterSimGlobals {
  HUNTER_DEFS: Record<HunterId, HunterDef>;
  GEM_UPGRADE_ALIASES: Record<string, string>;
  GEM_TREES: Record<string, any>;
  NAV_UNLOCKS: Record<string, any>;
  ALL_UPGRADE_CATEGORIES: Record<string, UpgradeCategory>;
  AllocSpace: AllocSpaceApi;
  HunterOptimizer: HunterOptimizerApi;
  OptimizerObjective: typeof OptimizerObjective;
  HunterSim: HunterSimApi;
  StoreSchema: StoreSchemaApi;
  CostFormulas: Record<string, any>;
  IncomeModel: Record<string, any>;
  HunterStatPath: Record<string, any>;
  HUNTERSIM_ASSET_BASE?: string;
  HUNTERSIM_EMBEDDED?: boolean;
  HUNTERSIM_WORKER_URL?: string;
  AccountState: { workerCfg(cfg: OptimizerConfig): Pick<OptimizerConfig, 'hunter' | 'level' | 'hunterStats' | 'baseOverrides' | 'globalUpgrades' | 'gemPlannerStore' | 'TALENTS' | 'ATTRIBUTES'> };
  releaseScoringPools(): void;
  cancelOptimizerRun(): void;
  createHunterPathScorer(cfg: OptimizerConfig, mode: OptimizeMode): Promise<{
    score(pairs: AllocationPair[], iterations: number): Promise<ScoreBatch>;
    release(): void;
    abort(): void;
  }>;
  talentBudgetForLevel(level: number): number;
  attributeBudgetForLevel(level: number): number;
  buildNestedUpgrades(flat: Record<string, number>): Record<string, Record<string, number>>;
  defaultGemState(): Record<string, GemTreeState>;
  parseBuildCode(code: string): Promise<ParsedBuild | null>;
  generateBuildCode(hunter: HunterId, buildData: Partial<StoredBuild>, hunterStats: Record<string, number>, globalUpgrades: Record<string, number>, gems: Record<string, GemTreeState>): Promise<string>;
  isPureLootOverrideKey(key: string): boolean;
  resourcesFor(hunter: HunterId, includeInscriptions: boolean): string[];
  greedyPurchasePath: typeof greedyPurchasePath;
  runOptimizer: typeof runOptimizer;
}

interface Window extends HunterSimGlobals {}
declare namespace globalThis {
  // eslint-disable-next-line no-var
  var window: Window & typeof globalThis;
}

// ---------------------------------------------------------------------------------------
// NOT YET DECLARED
// ---------------------------------------------------------------------------------------
// app.js and shipsPage.js export ~35 more globals (renderFleetPage, openGearEffectivePath,
// mapCifiSaveToStore, ...). They are page-rendering entry points with heavy DOM interaction and
// are excluded from jsconfig.json's `include` for now -- declaring them here without also
// type-checking their bodies would give a false sense of coverage. Add each one when its file
// gains JSDoc annotations and joins the checked set. See CLAUDE.md's TypeScript section.
