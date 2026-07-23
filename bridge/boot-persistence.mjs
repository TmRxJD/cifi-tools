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

export async function isBootEntryInstalled() {
  if (process.platform === 'win32') {
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
      return Boolean(String(stdout || '').trim())
    } catch {
      return false
    }
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
    const escaped = launchCommand.replace(/'/g, "''")
    await runPowerShell(`
$cmd = '${escaped}'
Set-ItemProperty -Path 'Registry::${WINDOWS_RUN_KEY}' -Name '${BOOT_LABEL}' -Value $cmd
Write-Output "Registered startup command"
`)
    log('Registered CIFI Bridge to start when you sign in to Windows.')
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
