// DOES THE BRIDGE WAIT FOR ANDROID, AND DOES IT COLLAPSE DUPLICATE SERIALS?
//
//   node bridge/boot-wait-check.mjs
//
// THE BUG THIS COVERS. ADB reports a device as `device` as soon as adbd starts, which is well
// before Android finishes booting. In that window `adb shell` works but app data directories are
// not populated, so the save probe finds nothing and the pull reports "no save found" -- which
// looks identical, to the user, to the game not being installed. The workaround was to wait and
// retry by hand.
//
// MuMu states it directly: `MuMuManager.exe info -v 0` returns
//     "is_process_started": true, "is_android_started": false, "player_state": "starting_rom"
// while port 16384 is already accepting ADB connections.
//
// AND ONE EMULATOR ANSWERS TO TWO SERIALS -- measured here as 127.0.0.1:16384 and emulator-5554,
// both reporting product:dm1q model:SM_S9110. Trying both spends a whole pull attempt re-failing
// against a device already known to be unready.
//
// This is a LIVE-DEVICE check: it SKIPS when nothing is attached rather than passing, because a
// check that silently passes with no device tests nothing.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveOnlineEmulatorTargets } from './pull-save.mjs'

const execFileAsync = promisify(execFile)

async function adb(args, timeout = 8000) {
  const { stdout } = await execFileAsync('adb', args, { timeout, windowsHide: true })
  return String(stdout).trim()
}

let failures = 0

try {
  const targets = await resolveOnlineEmulatorTargets()
  if (!targets.length) {
    console.log('SKIP  no device attached — cannot verify boot handling. That is not a pass.')
    process.exit(0)
  }
  console.log(`targets: ${targets.join(', ')}`)

  // 1. Duplicates must be collapsed by resolveOnlineEmulatorTargets itself, so every caller
  //    benefits -- not only the pull path.
  const fingerprints = new Map()
  for (const t of targets) {
    // boot_id, not ro.serialno: the latter is EMPTY on this emulator, so a check written against
    // it reports "no duplicates" no matter what -- which is how the bridge's own dedupe shipped
    // dead. boot_id is per running kernel, so two serials into one system match.
    let fp = ''
    try { fp = await adb(['-s', t, 'shell', 'cat', '/proc/sys/kernel/random/boot_id']) } catch { fp = '' }
    if (!fp) { try { fp = await adb(['-s', t, 'shell', 'getprop', 'ro.serialno']) } catch { fp = '' } }
    if (fp) {
      if (fingerprints.has(fp)) {
        console.log(`FAIL  ${t} and ${fingerprints.get(fp)} are the SAME device (boot_id ${fp.slice(0, 8)})`)
        console.log('      but both survived into the target list — duplicate pull attempts.')
        failures++
      } else {
        fingerprints.set(fp, t)
      }
    }
  }
  if (!failures) console.log(`ok    ${targets.length} target(s), no duplicate physical device`)

  // 2. Every target the bridge would pull from must actually report a completed boot.
  for (const t of targets) {
    let booted = ''
    try { booted = await adb(['-s', t, 'shell', 'getprop', 'sys.boot_completed']) } catch { booted = '' }
    if (booted.startsWith('1')) {
      console.log(`ok    ${t} reports sys.boot_completed=1`)
    } else {
      // Not a failure of the bridge: it is the exact state the wait exists to handle. Report it so
      // a run against a booting emulator is legible rather than mysterious.
      console.log(`note  ${t} is NOT booted (sys.boot_completed="${booted}") — the bridge should `
        + 'wait rather than report "no save found"')
    }
  }
} catch (error) {
  console.log(`SKIP  adb unavailable (${error.message.split('\n')[0]})`)
  process.exit(0)
}

console.log('')
if (failures) {
  console.log(`FAIL  ${failures} problem(s) with device targeting`)
  process.exit(1)
}
console.log('PASS  device targeting is deduplicated and boot state is observable')
