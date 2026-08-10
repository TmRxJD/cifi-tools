import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const BOOT_LABEL = 'TrackerBridge'
/**
 * Windows autostart is a Scheduled Task, not the per-user Run registry key.
 *
 * Two reasons. First, reliability: the Run key is processed by Explorer early in
 * logon, before a login shell has populated PATH, which is why a bare `npx`
 * command registered here could report success and then never start. Task
 * Scheduler runs the command in a proper session.
 *
 * Second, reputation: a script writing an autorun registry key and launching the
 * result windowless is one of the behaviours Microsoft Defender's ML model
 * scores as a dropper. The sibling Tracker Bridge was being flagged as
 * Trojan:Script/Wacatac.C!ml for exactly this shape.
 *
 * schtasks.exe is called directly, so no PowerShell -- and no
 * -ExecutionPolicy Bypass -- is involved in autostart.
 */
const WINDOWS_TASK_NAME = 'CifiBridge'

/** Command used for OS startup entries — runs detached in the background. */
export function buildBootLaunchCommand() {
  return 'npx cifi-bridge --daemon --skip-intro --no-boot'
}

function macLaunchAgentPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.cifihuntersim.cifi-bridge.plist')
}

function linuxAutostartPath() {
  return path.join(os.homedir(), '.config', 'autostart', 'cifi-bridge.desktop')
}

async function runSchtasks(args, timeoutMs = 15_000) {
  return await execFileAsync('schtasks', args, { timeout: timeoutMs, windowsHide: true })
}

// `npx` on Windows resolves to npx.cmd (a batch file), which CreateProcess cannot launch
// directly -- it needs a shell (cmd.exe) to interpret it. The Run key used to store the bare
// "npx cifi-bridge ..." string with no shell wrapper, unlike the mac/linux paths below (which
// already go through /bin/zsh -lc / /bin/sh -lc). That's the likely cause of "confirmed as
// registered but never actually starts": at user logon, Explorer processes the Run key well
// before the shell profile/PATH used by an interactive terminal is fully populated, so even
// when the raw command DOES get shelled out correctly, bare "npx" can fail to resolve at all.
// Fixing this two ways: (1) always wrap the Windows command through `cmd.exe /c` explicitly so
// the .cmd shim is guaranteed to run through a shell regardless of how the Run key invokes it,
// and (2) resolve npx's fully-qualified path via `where npx` at the moment the user enables
// this (inside a real, working terminal session) and bake that absolute path into the
// registered command, so boot-time PATH resolution is never a factor at all.
async function resolveWindowsNpxPath() {
  try {
    const { stdout } = await execFileAsync('where', ['npx'], { timeout: 10_000, windowsHide: true })
    const first = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    return first || null
  } catch {
    return null
  }
}

// Returns the registered task's command line (Windows only), or null when the
// task does not exist. /FO LIST /V includes the "Task To Run" field.
async function readWindowsBootEntryValue() {
  try {
    const { stdout } = await runSchtasks(['/Query', '/TN', WINDOWS_TASK_NAME, '/FO', 'LIST', '/V'])
    const line = String(stdout || '')
      .split(/\r?\n/)
      .find((row) => /^\s*Task To Run:/i.test(row))
    const value = line ? line.split(':').slice(1).join(':').trim() : ''
    return value || null
  } catch {
    return null
  }
}

// True if a boot entry exists but is still the OLD unwrapped "npx cifi-bridge ..." format
// (registered before the cmd.exe-wrapping fix) -- that format is why "confirmed as registered
// but never actually starts at boot" could happen: a bare npx.cmd target isn't reliably
// launchable straight from the Run key. Used to silently self-heal existing installs without
// requiring the user to manually remove and re-enable the setting.
export async function isBootEntryStale() {
  if (process.platform !== 'win32') return false
  const value = await readWindowsBootEntryValue()
  return Boolean(value) && !value.startsWith('cmd.exe')
}

export async function isBootEntryInstalled() {
  if (process.platform === 'win32') {
    // Either mechanism counts: a Scheduled Task when elevation allowed one,
    // otherwise the Startup-folder script.
    if (fs.existsSync(windowsStartupEntryPath())) return true
    return Boolean(await readWindowsBootEntryValue())
  }

  if (process.platform === 'darwin') {
    return fs.existsSync(macLaunchAgentPath())
  }

  if (process.platform === 'linux') {
    return fs.existsSync(linuxAutostartPath())
  }

  return false
}

// Windows Startup folder entry, used when a Scheduled Task cannot be created
// (ONLOGON tasks require elevation, which this per-user install does not have).
function windowsStartupEntryPath() {
  return path.join(
    os.homedir(),
    'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    'CIFI Bridge.cmd',
  )
}

export async function installBootEntry(log = console.log) {
  const launchCommand = buildBootLaunchCommand()

  if (process.platform === 'win32') {
    const npxPath = await resolveWindowsNpxPath()
    const resolvedCommand = npxPath
      ? `"${npxPath}" cifi-bridge --daemon --skip-intro --no-boot`
      : launchCommand
    // Wrapped through cmd.exe so the npx.cmd shim runs via a shell, using the
    // absolute path when one was found so boot-time PATH is never a factor.
    const fullCommand = `cmd.exe /c "${resolvedCommand.replace(/"/g, '\\\\"')}"`

    // Prefer a Scheduled Task: it runs in a proper session (the Run key fires
    // before PATH is populated, which is why autostart used to register and
    // then never start) and it is visible and removable in Task Scheduler.
    //
    // But /SC ONLOGON requires elevation, and this installs per-user with no
    // UAC prompt by design, so for most users it fails with "Access is denied".
    // Fall back to a Startup-folder script: no elevation needed, and it is a
    // plain file the user can see and delete -- unlike a registry Run key,
    // which is hidden and part of the behaviour Defender scores as a dropper.
    try {
      await runSchtasks(['/Create', '/TN', WINDOWS_TASK_NAME, '/TR', fullCommand, '/SC', 'ONLOGON', '/F'])
      log('Registered CIFI Bridge to start when you sign in to Windows (Scheduled Task).')
      return
    } catch {
      // Elevation unavailable -- use the Startup folder instead.
    }

    const startupPath = windowsStartupEntryPath()
    fs.mkdirSync(path.dirname(startupPath), { recursive: true })
    // Write resolvedCommand, not fullCommand: the backslash-escaped quotes in
    // fullCommand are for passing a single argument to schtasks. A .cmd file
    // needs plain quoting, and needs no cmd.exe wrapper -- it is already a
    // batch file. CRLF because cmd.exe parses LF-only batch files unreliably.
    const eol = String.fromCharCode(13, 10)
    fs.writeFileSync(startupPath, '@echo off' + eol + resolvedCommand + eol, 'utf8')
    log('Registered CIFI Bridge to start when you sign in to Windows (Startup folder).')
    return
  }

  if (process.platform === 'darwin') {
    const plistPath = macLaunchAgentPath()
    fs.mkdirSync(path.dirname(plistPath), { recursive: true })
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cifihuntersim.cifi-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${launchCommand}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`
    fs.writeFileSync(plistPath, plist, 'utf8')
    try {
      await execFileAsync('launchctl', ['load', plistPath], { timeout: 10_000 })
    } catch {
      void 0
    }
    log('Registered CIFI Bridge Launch Agent (starts at login).')
    return
  }

  if (process.platform === 'linux') {
    const desktopPath = linuxAutostartPath()
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true })
    const desktop = `[Desktop Entry]
Type=Application
Name=CIFI Bridge
Comment=Local save finder for CIFI HunterSim
Exec=/bin/sh -lc "${launchCommand.replace(/"/g, '\\"')}"
Terminal=false
X-GNOME-Autostart-enabled=true
`
    fs.writeFileSync(desktopPath, desktop, 'utf8')
    log('Registered CIFI Bridge autostart entry.')
    return
  }

  log('Automatic startup is not supported on this platform.')
}

export async function removeBootEntry(log = console.log) {
  if (process.platform === 'win32') {
    // Clear both mechanisms: which one was used depends on whether the task
    // could be created, so removal must not assume either.
    try {
      await runSchtasks(['/Delete', '/TN', WINDOWS_TASK_NAME, '/F'])
    } catch {
      // No Scheduled Task registered.
    }
    try {
      fs.rmSync(windowsStartupEntryPath(), { force: true })
    } catch {
      // No Startup-folder entry either.
    }
    log('Removed CIFI Bridge from Windows startup.')
    return
  }

  if (process.platform === 'darwin') {
    const plistPath = macLaunchAgentPath()
    try {
      await execFileAsync('launchctl', ['unload', plistPath], { timeout: 10_000 })
    } catch {
      void 0
    }
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath)
    }
    log('Removed CIFI Bridge Launch Agent.')
    return
  }

  if (process.platform === 'linux') {
    const desktopPath = linuxAutostartPath()
    if (fs.existsSync(desktopPath)) {
      fs.unlinkSync(desktopPath)
    }
    log('Removed CIFI Bridge autostart entry.')
    return
  }

  log('No startup entry to remove on this platform.')
}
