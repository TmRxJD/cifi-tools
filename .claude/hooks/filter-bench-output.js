#!/usr/bin/env node
// PreToolUse hook (Bash matcher), HunterSim-specific.
//
// WHY. tools/bench/all.js and tools/bench/run.js print one line per gate --
// currently 67 lines, nearly all "PASS". Reading that wall of text every time
// costs real tokens for information already known (most gates pass every run);
// what actually matters is which ones did NOT, plus the final tally. This is
// the same pattern Anthropic's own docs recommend (filter verbose command
// output in a PreToolUse hook before it reaches the model), applied to this
// project's own noisiest commands rather than a generic test runner.
//
// Node, not jq: this machine has no jq on PATH (verified), and node is already
// the tool of choice for JSON work in this project's own scripts.
//
// SAFE BY CONSTRUCTION: only rewrites a command that already targets one of
// the known bench entry points below; every other Bash call passes through
// completely unmodified (`{}`, meaning "no change").

const KNOWN_VERBOSE = [
  /\bnode\s+tools[\/\\]bench[\/\\]all\.js\b/,
  /\bnode\s+tools[\/\\]bench[\/\\]run\.js\b/,
];

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(input); } catch { process.stdout.write('{}'); return; }

  const cmd = data?.tool_input?.command;
  if (typeof cmd !== 'string' || !KNOWN_VERBOSE.some((re) => re.test(cmd))) {
    process.stdout.write('{}');
    return;
  }
  // Already piped/redirected by the caller (e.g. `| tail`, `> file`) -- don't
  // stack a second filter on top of one the caller deliberately wrote.
  if (/[|>]/.test(cmd)) {
    process.stdout.write('{}');
    return;
  }

  // Filter ONLY on a clean exit (code 0). On any nonzero exit something is
  // genuinely wrong and the filter is skipped entirely -- full output, same
  // exit code -- so a crash can never be silently hidden behind a grep miss.
  // On a clean exit, keep non-PASS gate lines plus the final tally (its own
  // format is "name  PASS  PASS  detail" per gate; a real failure always
  // contains FAIL/ERROR/SKIP, and the tally line contains "passed").
  const filtered = `__out=$(${cmd} 2>&1); __ec=$?; `
    + `if [ $__ec -eq 0 ]; then echo "$__out" | grep -E "FAIL|ERROR|SKIP|passed"; `
    + `else echo "$__out"; fi; exit $__ec`;
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...data.tool_input, command: filtered },
    },
  };
  process.stdout.write(JSON.stringify(out));
});
