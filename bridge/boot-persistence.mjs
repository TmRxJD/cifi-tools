import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const BOOT_LABEL = 'TrackerBridge'
const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

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

async function runPowerShell(script, timeoutMs = 15_000) {
  await execFileAsync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: timeoutMs, windowsHide: true },
  )
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

// Returns the raw registered Run-key command string (Windows only), or null if not installed.
async function readWindowsBootEntryValue() {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$v = Get-ItemProperty -Path 'Registry::${WINDOWS_RUN_KEY}' -Name '${BOOT_LABEL}' -ErrorAction SilentlyContinue; if ($v.'${BOOT_LABEL}') { Write-Output $v.'${BOOT_LABEL}' }`,
      ],
      { timeout: 15_000, windowsHide: true },
    )
    const value = String(stdout || '').trim()
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

export async function installBootEntry(log = console.log) {
  const launchCommand = buildBootLaunchCommand()

  if (process.platform === 'win32') {
    const npxPath = await resolveWindowsNpxPath()
    const resolvedCommand = npxPath
      ? `"${npxPath}" cifi-bridge --daemon --skip-intro --no-boot`
      : launchCommand
    // Wrapped through cmd.exe /c so the npx.cmd shim always runs via a real shell, regardless
    // of how the Run key invokes it -- and using the resolved absolute path (when found) means
    // boot-time PATH state can't be the reason it silently fails to start.
    const fullCommand = `cmd.exe /c "${resolvedCommand.replace(/"/g, '\\"')}"`
    const escaped = fullCommand.replace(/'/g, "''")
    await runPowerShell(`
$cmd = '${escaped}'
Set-ItemProperty -Path 'Registry::${WINDOWS_RUN_KEY}' -Name '${BOOT_LABEL}' -Value $cmd
Write-Output "Registered startup command"
`)
    log(npxPath
      ? 'Registered CIFI Bridge to start when you sign in to Windows.'
      : 'Registered CIFI Bridge to start when you sign in to Windows (could not resolve an absolute path to npx -- if it still doesn\'t start at boot, make sure Node.js is on your SYSTEM PATH, not just your user PATH).')
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
    await runPowerShell(`
Remove-ItemProperty -Path 'Registry::${WINDOWS_RUN_KEY}' -Name '${BOOT_LABEL}' -ErrorAction SilentlyContinue
Write-Output "Removed startup command"
`)
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
