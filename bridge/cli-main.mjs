import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureAdbReady, registerAdbOnPath } from './adb-setup.mjs'
import { findInstalledAdbOffPath, resolveAdbExecutable } from './adb-resolve.mjs'
import { installBootEntry, isBootEntryInstalled, isBootEntryStale, removeBootEntry } from './boot-persistence.mjs'
import { BRIDGE_VERSION, startLocalAdbBridge } from './server.mjs'
import { maybeUpdateBridge } from './update-check.mjs'

const DISPLAY_NAME = 'CIFI Bridge'
const NPM_URL = 'https://www.npmjs.com/package/cifi-bridge'
const SOURCE_URL = 'https://www.npmjs.com/package/cifi-bridge?activeTab=code'
const NPX_COMMAND = 'npx cifi-bridge'

function parseCliArgs(argv) {
  const flags = new Set()
  for (const arg of argv) {
    if (arg.startsWith('-')) flags.add(arg)
  }
  return {
    help: flags.has('--help') || flags.has('-h'),
    version: flags.has('--version') || flags.has('-v'),
    daemon: flags.has('--daemon') || flags.has('-d'),
    foreground: flags.has('--foreground'),
    skipIntro: flags.has('--skip-intro'),
    noBoot: flags.has('--no-boot'),
    boot: flags.has('--boot'),
    removeBoot: flags.has('--remove-boot'),
    installPath: flags.has('--install-path'),
    noUpdate: flags.has('--no-update'),
  }
}

function printHelp() {
  console.log(`${DISPLAY_NAME} — read-only local helper to find your CIFI save file.`)
  console.log('')
  console.log(`Run ${NPX_COMMAND} and follow the prompts (startup, background mode, PATH setup).`)
  console.log('')
  console.log('Optional flags (automation / power users):')
  console.log(`  ${NPX_COMMAND} --daemon        Run in background; safe to close terminal`)
  console.log(`  ${NPX_COMMAND} --boot          Register OS login startup without prompting`)
  console.log(`  ${NPX_COMMAND} --no-boot       Skip startup registration prompts`)
  console.log(`  ${NPX_COMMAND} --remove-boot   Remove OS login startup entry`)
  console.log(`  ${NPX_COMMAND} --install-path  Add discovered ADB folder to user PATH`)
  console.log(`  ${NPX_COMMAND} --no-update     Skip the check for a newer CIFI Bridge`)
  console.log(`  ${NPX_COMMAND} --skip-intro    Skip first-run trust message`)
  console.log('')
  console.log(`npm package: ${NPM_URL}`)
  console.log(`Source code: ${SOURCE_URL}`)
}

function printIntro(log = console.log) {
  log('')
  log(`${DISPLAY_NAME} helps the HunterSim website locate DATA.text on your computer.`)
  log('It only reads your save file — it does not modify the game or inject code into it.')
  log('The package is open source and published on the public npm registry:')
  log(`  ${NPM_URL}`)
  log(`  ${SOURCE_URL}`)
  log('')
  log('You only run this once — emulator or USB device share the same bridge.')
  log('On the HunterSim website, click Allow if Chrome or Edge asks for local network access.')
  log('')
}

async function askYesNo(question, defaultYes = true) {
  if (!process.stdin.isTTY) return defaultYes
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] '
    const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase()
    if (!answer) return defaultYes
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

function spawnBackgroundBridge() {
  const entry = fileURLToPath(new URL('./bin/cifi-bridge.js', import.meta.url))
  const child = spawn(process.execPath, [entry, '--foreground', '--skip-intro', '--no-boot'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  })
  child.unref()
}

async function runInstallPath(log = console.log) {
  const adb = await resolveAdbExecutable()
  if (adb) {
    await registerAdbOnPath(adb, log)
    log('ADB is on your PATH for this user.')
    return true
  }

  const offPath = findInstalledAdbOffPath()
  if (offPath) {
    await registerAdbOnPath(offPath, log)
    log('Added discovered ADB to your user PATH.')
    return true
  }

  if (process.platform === 'win32') {
    log('ADB was not found automatically.')
    log(`Close this window, open PowerShell as Administrator, then run: ${NPX_COMMAND}`)
    log('The bridge can also install platform-tools automatically when you start it normally.')
    return false
  }

  log('ADB was not found. The bridge will try to install platform-tools automatically.')
  return false
}

async function promptPathSetupIfNeeded(log = console.log) {
  if (!process.stdin.isTTY) return

  const adb = await resolveAdbExecutable()
  if (adb) return

  const offPath = findInstalledAdbOffPath()
  if (!offPath) return

  log(`Found adb installed at: ${offPath}`)
  const wantsPath = await askYesNo(
    process.platform === 'win32'
      ? 'Add Android platform-tools to your user PATH? (If this fails, restart PowerShell as Administrator and run CIFI Bridge again.)'
      : 'Add Android platform-tools to your user PATH?',
    true,
  )
  if (wantsPath) {
    await registerAdbOnPath(offPath, log)
  }
}

async function resolveBootAndBackground(options, log = console.log) {
  // Self-heal an existing-but-stale boot entry (the pre-fix format that could get "confirmed as
  // registered" but silently never actually launch at sign-in) unconditionally, even on a
  // non-interactive boot-triggered daemon launch -- that's specifically the invocation that
  // would otherwise never reach either branch below (it's launched with --no-boot and no TTY),
  // so it's also the one invocation where healing actually matters most.
  if (await isBootEntryStale()) {
    await installBootEntry(log)
  }

  if (options.boot) {
    await installBootEntry(log)
  } else if (!options.noBoot && process.stdin.isTTY) {
    const already = await isBootEntryInstalled()
    if (already) {
      const remove = await askYesNo(
        'CIFI Bridge is registered to start when you sign in. Remove that startup entry?',
        false,
      )
      if (remove) {
        await removeBootEntry(log)
      }
    } else {
      const wantsBoot = await askYesNo(
        'Start CIFI Bridge automatically when you sign in to this computer?',
        true,
      )
      if (wantsBoot) {
        await installBootEntry(log)
      }
    }
  }

  if (options.daemon) return true

  if (process.stdin.isTTY && !options.foreground) {
    return askYesNo(
      'Run CIFI Bridge in the background so you can close this terminal?',
      true,
    )
  }

  return false
}

export async function runCliMain(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv)

  if (options.help) {
    printHelp()
    return
  }

  if (options.version) {
    console.log(BRIDGE_VERSION)
    return
  }

  if (options.removeBoot) {
    await removeBootEntry()
    return
  }

  if (options.installPath) {
    await runInstallPath()
    return
  }

  if (options.daemon && !options.foreground) {
    spawnBackgroundBridge()
    console.log(`${DISPLAY_NAME} is running in the background on port 43791.`)
    console.log('You can safely close this terminal while importing from the HunterSim website.')
    return
  }

  if (!options.skipIntro && !options.foreground) {
    printIntro()
  }

  if (!options.foreground) {
    const handedOff = await maybeUpdateBridge({
      currentVersion: BRIDGE_VERSION,
      argv,
      noUpdate: options.noUpdate,
      ask: question => askYesNo(question, true),
    })
    if (handedOff) return
  }

  await ensureAdbReady()
  await promptPathSetupIfNeeded()

  const runInBackground = await resolveBootAndBackground(options)
  if (runInBackground && !options.foreground) {
    spawnBackgroundBridge()
    console.log(`${DISPLAY_NAME} is running in the background on port 43791.`)
    console.log('You can safely close this terminal while importing from the HunterSim website.')
    return
  }

  console.log('Connect an emulator or USB phone from the HunterSim import page.')
  startLocalAdbBridge({ backgroundCapable: true })
}
