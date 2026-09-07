#!/usr/bin/env bash
# OVERNIGHT VALIDATION. Scoped to finish in ONE night, not several.
#
# SIZED FROM MEASURED TIMINGS, NOT OPTIMISM. A full 195-build sweep is 8-12 hours: median per-build
# 456s, max 1207s in a LOW-LEVEL sample, and borge@72 alone took 1836s; at 7 per batch that is 28
# batches of ~800s before counting the expensive 60-84 tail. That is multiple nights, and a first
# version of this file queued it anyway.
#
# So this runs the STRATIFIED SAMPLE instead -- the gate CLAUDE.md nominates for exactly this
# ("a gate too slow to run is a gate nobody runs"). It draws one build per level band per hunter,
# so it spans the whole range rather than skewing to the cheap low-level builds where nothing
# interesting happens. The pass criteria are IDENTICAL to a full sweep; only the count changes.
#
# The seed is FIXED here so tonight's run is reproducible tomorrow -- a failure that cannot be
# replayed is not a bug report.
set -u

log() { echo "$(date '+%H:%M:%S')  $*" >> overnight-plan.log; }
log "=== OVERNIGHT RUN START ==="

# 1. Let anything already computing finish. Character classes keep grep from matching itself.
while ps -ef 2>/dev/null | grep -qE "[e]ffort-level-check|[b]ossfinal"; do sleep 30; done
log "in-flight jobs finished"

# 2. PRIORITY: the borge@72 boss defect. It PASSED while losing 90% loot and 44 stages, which means
#    the boss objective ranked a strictly worse build higher, or the new per-mode grading compares
#    the wrong quantity. Cheap to run and it is a defect in today's work, so it goes first.
log "--- borge@72 boss objective diagnosis ---"
node tools/bench/mode-fidelity-matrix.js --only=borge@72 > overnight-borge72.log 2>&1
log "borge@72 diagnosis exited $?"

# 3. Full gate suite. Bounded now that effort-level-check is capped.
log "--- all.js gate suite ---"
node tools/bench/all.js > overnight-allgates.log 2>&1
log "all.js exited $?"

# 4. Stratified sample across all three hunters. 42 builds -> ~6 batches -> roughly 1.5-2 hours.
log "--- stratified sample sweep (42 builds, seed 20260907) ---"
for attempt in 1 2 3 4; do
  node tools/bench/run.js --all --resume --sample=42 --seed=20260907 \
    --out=overnight-sample.json >> overnight-sweep.log 2>&1
  # ANCHORED: "^0 build(s) to run" cannot be satisfied by "30 build(s) to run".
  if grep -qE "^0 build\(s\) to run" overnight-sweep.log; then
    log "sample sweep complete after attempt $attempt"
    break
  fi
  log "sample attempt $attempt finished with builds remaining"
done

log "=== OVERNIGHT RUN COMPLETE ==="
