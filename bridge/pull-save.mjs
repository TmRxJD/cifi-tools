import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { normalizeAdbExecError, requireAdbExecutable } from './adb-resolve.mjs'
import {
  buildEmulatorPullPaths,
  buildSavePullPaths,
  CIFI_ANDROID_PACKAGE,
  CIFI_ANDROID_PACKAGES,
  CIFI_INTERNAL_SAVE_PATH,
  CIFI_SAVE_FILENAMES,
  KNOWN_EMULATOR_ADB_HOSTS,
} from './save-paths.mjs'
import { bytesLookLikeCifiSave, bytesLookLikeShellFailure } from './save-bytes.mjs'
import { resolveDeviceDisplayName } from './device-label.mjs'
import {
  isTransientUsbAdbError,
  resolveUsbPullRetries,
  waitForStableAdbDevice,
  waitForUsbStackSettle,
} from './usb-settle.mjs'

const execFileAsync = promisify(execFile)
const ROOT_RESTART_DELAY_MS = 1_500
/** Dead emulator ports should fail fast instead of blocking each pull for ~15s. */
const ADB_CONNECT_TIMEOUT_MS = 2_500
const ADB_PATH_PROBE_TIMEOUT_MS = 5_000
const ADB_FIND_SAVE_TIMEOUT_MS = 12_000
const ADB_ROOT_TIMEOUT_MS = 8_000

export class BridgeNoDeviceError extends Error {
  code = 'no-device'

  constructor(message) {
    super(message)
    this.name = 'BridgeNoDeviceError'
  }
}

export class BridgeSaveNotFoundError extends Error {
  code = 'save-not-found'

  constructor(message, deviceSerial) {
    super(message)
    this.name = 'BridgeSaveNotFoundError'
    this.deviceSerial = deviceSerial
  }
}

function adbArgs(serial, args) {
  return serial ? ['-s', serial, ...args] : args
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runAdb(serial, args, timeoutMs = 120_000) {
  const adb = await requireAdbExecutable()
  try {
    const { stdout, stderr } = await execFileAsync(adb, adbArgs(serial, args), {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return `${stdout || ''}${stderr || ''}`.trim()
  } catch (error) {
    throw normalizeAdbExecError(error)
  }
}

async function runAdbBinary(serial, args, timeoutMs = 120_000) {
  const adb = await requireAdbExecutable()
  try {
    const { stdout } = await execFileAsync(adb, adbArgs(serial, args), {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'buffer',
    })
    return stdout
  } catch (error) {
    throw normalizeAdbExecError(error)
  }
}

/** @param {string | undefined} customPort */
export function buildKnownHosts(customPort) {
  const hosts = []
  const port = String(customPort ?? '').trim()
  if (/^\d{4,5}$/.test(port)) {
    hosts.push(`127.0.0.1:${port}`)
  }
  for (const host of KNOWN_EMULATOR_ADB_HOSTS) {
    if (!hosts.includes(host)) {
      hosts.push(host)
    }
  }
  return hosts
}

/** True for TCP emulators (127.0.0.1:port) and the Android Emulator serial form. */
export function isEmulatorAdbSerial(serial) {
  const trimmed = String(serial ?? '').trim()
  return /^127\.0\.0\.1:\d+$/.test(trimmed) || /^emulator-\d+$/.test(trimmed)
}

export function orderSerialsForPullAttempts(serials, hostPriority) {
  const ordered = []
  const seen = new Set()
  for (const host of hostPriority) {
    if (serials.includes(host) && !seen.has(host)) {
      ordered.push(host)
      seen.add(host)
    }
  }
  for (const serial of serials) {
    if (!seen.has(serial)) {
      ordered.push(serial)
      seen.add(serial)
    }
  }
  return ordered
}

/** USB phones/tablets first; emulators only if no physical device is online. */
export function orderSerialsPreferPhysical(serials, hostPriority) {
  const physical = []
  const emulators = []
  for (const serial of serials) {
    if (isEmulatorAdbSerial(serial)) {
      emulators.push(serial)
    } else {
      physical.push(serial)
    }
  }
  return [...physical, ...orderSerialsForPullAttempts(emulators, hostPriority)]
}

async function ensureAdbServer() {
  try {
    await runAdb(null, ['start-server'], 20_000)
  } catch {
    // Server may already be running.
  }
}

async function readAdbDevicesListing() {
  return runAdb(null, ['devices'], 15_000)
}

async function listDeviceSerials() {
  const listing = await readAdbDevicesListing()
  const serials = []
  for (const line of listing.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('List of devices')) continue
    const [serial, state] = trimmed.split(/\s+/)
    if (serial && state === 'device') {
      serials.push(serial)
    }
  }
  return serials
}

async function connectHost(host) {
  try {
    await runAdb(null, ['connect', host], ADB_CONNECT_TIMEOUT_MS)
    await delay(150)
    return (await getDeviceState(host)) === 'device'
  } catch {
    return false
  }
}

async function connectKnownHostsParallel(hosts) {
  if (!hosts.length) return
  await Promise.all(hosts.map(host => connectHost(host)))
}

/**
 * Probe each known emulator host with connect + get-state, then fall back to `adb devices`.
 * @param {string | undefined} customPort
 */
export async function resolveOnlineEmulatorTargets(customPort) {
  const hostPriority = buildKnownHosts(customPort)
  await ensureAdbServer()

  const targets = []
  const seen = new Set()

  const add = serial => {
    if (!serial || seen.has(serial)) return
    seen.add(serial)
    targets.push(serial)
  }

  for (const serial of await listDeviceSerials()) {
    add(serial)
  }

  const customPortTrimmed = String(customPort ?? '').trim()
  const needsHostProbe = targets.length === 0 || /^\d{4,5}$/.test(customPortTrimmed)

  if (needsHostProbe) {
    const hostsToProbe = /^\d{4,5}$/.test(customPortTrimmed)
      ? hostPriority.slice(0, 1)
      : hostPriority
    await connectKnownHostsParallel(hostsToProbe)
    for (const serial of await listDeviceSerials()) {
      add(serial)
    }
  }

  return orderSerialsForPullAttempts(targets, hostPriority)
}

async function getDeviceState(serial) {
  try {
    return await runAdb(serial, ['get-state'], 8_000)
  } catch {
    return ''
  }
}

/** @deprecated Kept for tests — production uses orderSerialsForPullAttempts + multi-device pull. */
export function pickPreferredDeviceSerial(serials, hostPriority = KNOWN_EMULATOR_ADB_HOSTS) {
  const ordered = orderSerialsForPullAttempts(serials, hostPriority)
  return ordered[0] ?? null
}

async function remotePathExists(serial, remotePath) {
  try {
    const out = await runAdb(
      serial,
      ['shell', 'test', '-f', remotePath, '&&', 'echo', 'ok'],
      ADB_PATH_PROBE_TIMEOUT_MS,
    )
    return /\bok\b/i.test(out)
  } catch {
    return false
  }
}

async function tryAdbRoot(serial) {
  try {
    const out = await runAdb(serial, ['root'], ADB_ROOT_TIMEOUT_MS)
    const rooted =
      /already running as root/i.test(out) || /restarting adbd as root/i.test(out)
    if (rooted && /restarting adbd/i.test(out)) {
      await delay(ROOT_RESTART_DELAY_MS)
    }
    return rooted
  } catch {
    return false
  }
}

async function pullRemotePath(serial, remotePath) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cifi-adb-bridge-'))
  const localPath = path.join(tmpDir, 'DATA.text')
  try {
    await runAdb(serial, ['pull', remotePath, localPath], 120_000)
    const bytes = await fs.readFile(localPath)
    if (bytes.byteLength <= 0) {
      throw new Error('Pulled save file is empty.')
    }
    return bytes
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function readViaShellCat(serial, remotePath) {
  try {
    const bytes = await runAdbBinary(serial, ['exec-out', 'cat', remotePath], 60_000)
    if (bytes?.byteLength > 0 && bytesLookLikeCifiSave(bytes)) {
      return bytes
    }
  } catch {
    // cat requires root or world-readable paths
  }
  return null
}

async function tryPullPath(serial, remotePath) {
  if (!(await remotePathExists(serial, remotePath))) {
    return null
  }
  try {
    const bytes = await pullRemotePath(serial, remotePath)
    if (bytesLookLikeCifiSave(bytes)) {
      return { remotePath, bytes }
    }
  } catch {
    // fall through to cat
  }
  const bytes = await readViaShellCat(serial, remotePath)
  if (bytes) {
    return { remotePath, bytes }
  }
  return null
}

async function findCifiSavePaths(serial, { includeDataData = false } = {}) {
  const roots = includeDataData
    ? ['/data/data', '/sdcard', '/storage/emulated/0']
    : ['/sdcard', '/storage/emulated/0']
  const namePattern = CIFI_SAVE_FILENAMES.map(name => `-iname ${name}`).join(' -o ')
  try {
    const out = await runAdb(
      serial,
      [
        'shell',
        `find ${roots.join(' ')} -maxdepth 8 \\( ${namePattern} \\) 2>/dev/null | head -n 6`,
      ],
      ADB_FIND_SAVE_TIMEOUT_MS,
    )
    return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

const STAGING_TMP_PATH = '/data/local/tmp/cifi_bridge_data.text'

/** USB phones must not treat Download/Downloads exports as the game save. */
export function isPhysicalAppSavePath(remotePath) {
  const normalized = String(remotePath ?? '').trim()
  if (!normalized) return false
  const lower = normalized.toLowerCase()
  if (/\/download(s)?\//.test(lower)) return false
  if (
    normalized.startsWith('run-as:')
    || normalized.startsWith('staging-tmp:')
  ) {
    return true
  }
  if (/\/android\/data\/[^/]+\/files\//i.test(normalized)) return true
  if (/\/data\/data\/[^/]+\/files\//i.test(normalized)) return true
  return false
}

async function discoverInstalledCifiPackages(serial) {
  const packages = new Set(CIFI_ANDROID_PACKAGES)
  try {
    const listing = await runAdb(serial, ['shell', 'pm', 'list', 'packages'], 45_000)
    for (const line of listing.split(/\r?\n/)) {
      const match = line.match(/^package:(.+)$/i)
      if (!match) continue
      const pkg = match[1].trim()
      if (/octocubegamescompany|\bcifi\b/i.test(pkg)) {
        packages.add(pkg)
      }
    }
  } catch {
    // pm list failed — use known package id only
  }
  return [...packages]
}

function buildOfficialAppSavePaths(packages = CIFI_ANDROID_PACKAGES) {
  const paths = []
  for (const pkg of packages) {
    for (const root of ['/storage/emulated/0', '/sdcard', '/mnt/sdcard']) {
      for (const filename of CIFI_SAVE_FILENAMES) {
        paths.push(`${root}/Android/data/${pkg}/files/${filename}`)
      }
    }
  }
  return paths
}

async function pullViaRunAs(serial, packages = CIFI_ANDROID_PACKAGES) {
  for (const pkg of packages) {
    for (const filename of CIFI_SAVE_FILENAMES) {
      try {
        const bytes = await runAdbBinary(
          serial,
          ['exec-out', 'run-as', pkg, 'cat', `files/${filename}`],
          60_000,
        )
        if (bytes?.byteLength > 0 && bytesLookLikeCifiSave(bytes)) {
          return { remotePath: `run-as:${pkg}/files/${filename}`, bytes }
        }
      } catch {
        continue
      }
    }
  }
  return null
}

async function pullViaRunAsShell(serial, packages = CIFI_ANDROID_PACKAGES) {
  for (const pkg of packages) {
    try {
      const catChain = CIFI_SAVE_FILENAMES
        .map(filename => `cat "files/${filename}" 2>/dev/null`)
        .join(' || ')
      const bytes = await runAdbBinary(
        serial,
        ['exec-out', 'run-as', pkg, 'sh', '-c', catChain],
        60_000,
      )
      if (bytes?.byteLength > 0 && bytesLookLikeCifiSave(bytes)) {
        return { remotePath: `run-as:${pkg}/sh-cat`, bytes }
      }
    } catch {
      continue
    }
  }
  return null
}

async function pullViaRunAsStaging(serial, packages = CIFI_ANDROID_PACKAGES) {
  for (const pkg of packages) {
    try {
      const catChain = CIFI_SAVE_FILENAMES
        .map(filename => `cp "files/${filename}" "${STAGING_TMP_PATH}" 2>/dev/null`)
        .join(' || ')
      await runAdb(serial, ['shell', 'run-as', pkg, 'sh', '-c', catChain], 30_000)
      const bytes = await readViaShellCat(serial, STAGING_TMP_PATH)
      await runAdb(serial, ['shell', 'rm', '-f', STAGING_TMP_PATH], 10_000).catch(() => {})
      if (bytes) {
        return { remotePath: `staging-tmp:${pkg}`, bytes }
      }
    } catch {
      continue
    }
  }
  return null
}

async function pullViaRunAsAll(serial, packages) {
  return (
    (await pullViaRunAsShell(serial, packages))
    ?? (await pullViaRunAs(serial, packages))
    ?? (await pullViaRunAsStaging(serial, packages))
  )
}

export function pickLargestSaveCandidate(candidates) {
  if (!candidates?.length) return null
  return candidates.reduce((best, current) =>
    current.bytes.byteLength > best.bytes.byteLength ? current : best,
  )
}

/** Phone saves live in app storage; Downloads often has a stale/irrelevant copy. */
async function discoverAndPullPhysical(serial) {
  const candidates = []
  const rejectedDownloadOnly = []
  const packages = await discoverInstalledCifiPackages(serial)

  const tryCollect = async puller => {
    const pulled = await puller()
    if (!pulled) return
    if (isPhysicalAppSavePath(pulled.remotePath)) {
      candidates.push(pulled)
      return
    }
    rejectedDownloadOnly.push(pulled)
  }

  await tryCollect(() => pullViaRunAsAll(serial, packages))

  const officialPaths = buildOfficialAppSavePaths(packages)
  for (const remotePath of officialPaths) {
    await tryCollect(() => tryPullPath(serial, remotePath))
  }

  const rooted = await tryAdbRoot(serial)
  if (rooted) {
    for (const pkg of packages) {
      for (const filename of CIFI_SAVE_FILENAMES) {
        const internal = `/data/data/${pkg}/files/${filename}`
        await tryCollect(() => tryPullPath(serial, internal))
      }
    }
    await tryCollect(() => tryPullPath(serial, CIFI_INTERNAL_SAVE_PATH))
  }

  const discovered = await findCifiSavePaths(serial, { includeDataData: rooted })
  const sortedDiscovered = [...discovered]
    .filter(remotePath => isPhysicalAppSavePath(remotePath))
    .sort((a, b) => {
      const score = p =>
        (/\/android\/data\//i.test(p) ? 4 : 0) + (/\/data\/data\//i.test(p) ? 8 : 0)
      return score(b) - score(a)
    })
  for (const remotePath of sortedDiscovered) {
    await tryCollect(() => tryPullPath(serial, remotePath))
  }

  const best = pickLargestSaveCandidate(candidates)
  if (best) return best

  if (rejectedDownloadOnly.length > 0) {
    throw new BridgeSaveNotFoundError(
      "Found a CIFI save in Download/Downloads but could not read the game's save from app storage. Stop any old CIFI Bridge process, run: npx cifi-bridge, save in CIFI, then retry USB.",
      serial,
    )
  }

  return null
}

async function discoverAndPullEmulator(serial) {
  const pullPaths = buildEmulatorPullPaths()

  for (const remotePath of pullPaths) {
    const pulled = await tryPullPath(serial, remotePath)
    if (pulled) return pulled
  }

  const packages = await discoverInstalledCifiPackages(serial)
  const runAsPull = await pullViaRunAsAll(serial, packages)
  if (runAsPull) return runAsPull

  const rooted = await tryAdbRoot(serial)
  if (rooted) {
    const internal = await tryPullPath(serial, CIFI_INTERNAL_SAVE_PATH)
    if (internal) return internal
  }

  for (const candidate of await findCifiSavePaths(serial, { includeDataData: rooted })) {
    const pulled = await tryPullPath(serial, candidate)
    if (pulled) return pulled
  }

  return null
}

async function discoverAndPull(serial, options = {}) {
  if (options.preferPhysicalDevice) {
    return discoverAndPullPhysical(serial)
  }
  return discoverAndPullEmulator(serial)
}

async function tryPullOnSerial(serial, options = {}) {
  const pulled = await discoverAndPull(serial, options)
  if (!pulled) return null
  return {
    remotePath: pulled.remotePath,
    deviceSerial: serial,
    base64: pulled.bytes.toString('base64'),
    byteLength: pulled.bytes.byteLength,
  }
}

async function tryPullOnSerialWithRetries(serial, options = {}) {
  const preferPhysical = Boolean(options.preferPhysicalDevice)
  const maxAttempts = preferPhysical ? resolveUsbPullRetries() : 1
  const consoleUi = options.console

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (preferPhysical && attempt > 1) {
      consoleUi?.log(
        `Connecting to ${serial} via system adb (attempt ${attempt}/${maxAttempts})`,
        0.35 + (attempt - 1) * 0.08,
      )
      await waitForStableAdbDevice(serial, getDeviceState, msg => consoleUi?.log(msg))
    }

    try {
      consoleUi?.log('Pulling DATA.text from app storage…', 0.55)
      const result = await tryPullOnSerial(serial, options)
      if (result) {
        consoleUi?.log(
          `File extracted (${result.byteLength} bytes from ${result.remotePath})`,
          0.8,
        )
        return result
      }
    } catch (error) {
      if (!preferPhysical || !isTransientUsbAdbError(error) || attempt >= maxAttempts) {
        throw error
      }
      consoleUi?.log('Device dropped — waiting for USB to settle before retry…', 0.45)
      await waitForUsbStackSettle('retry', msg => consoleUi?.log(msg))
    }
  }

  return null
}

/**
 * Connect known emulator ports, use any online device, pull from each candidate path until
 * one succeeds.
 */
export async function pullCifiSave(options = {}) {
  const preferPhysical = Boolean(options.preferPhysicalDevice)
  const consoleUi = options.console

  consoleUi?.log('Sync request received from website', 0.05)
  consoleUi?.log('Connecting via system adb (host platform-tools)', 0.12)

  if (preferPhysical) {
    consoleUi?.log('Preparing USB — blocking Windows Autoplay reconnect noise', 0.18)
    await waitForUsbStackSettle('before', msg => consoleUi?.log(msg))
  }

  let candidates = await resolveOnlineEmulatorTargets(options.customPort)
  if (preferPhysical) {
    candidates = candidates.filter(serial => !isEmulatorAdbSerial(serial))
  }

  let lastTried = null

  for (const serial of candidates) {
    lastTried = serial
    const result = await tryPullOnSerialWithRetries(serial, options)
    if (result) {
      const deviceLabel = await resolveDeviceDisplayName(result.deviceSerial)
      if (preferPhysical) {
        consoleUi?.log('Letting USB connection settle safely…', 0.9)
        await waitForUsbStackSettle('after', msg => consoleUi?.log(msg))
      }
      consoleUi?.log('Sync complete — port released cleanly', 1)
      return { ...result, deviceLabel }
    }
  }

  if (!lastTried) {
    let devicesHint = ''
    try {
      devicesHint = await readAdbDevicesListing()
    } catch {
      devicesHint = '(adb devices failed)'
    }
    const unauthorized = /unauthorized/i.test(devicesHint)
    const offline = /\boffline\b/i.test(devicesHint)
    if (preferPhysical) {
      const usbMessage = unauthorized
        ? 'Your phone is connected but not authorized for USB debugging. Unplug the cable, revoke USB debugging authorizations in Developer options if needed, replug, and tap Allow on the phone when prompted.'
        : offline
          ? 'Your phone is connected but ADB shows it as offline. Try another USB cable or port, set USB mode to File Transfer, then unplug and replug.'
          : 'No authorized USB device detected. Plug in your phone with a data cable, enable USB debugging, allow the debugging prompt on the phone, and confirm adb devices lists it as "device".'
      throw new BridgeNoDeviceError(`${usbMessage}\n\nadb devices:\n${devicesHint}`)
    }
    throw new BridgeNoDeviceError(
      `No supported emulator detected. Start your emulator, enable ADB debugging, then try again.\n\nadb devices:\n${devicesHint}`,
    )
  }

  const physicalHint = preferPhysical
    ? ' The bridge only reads from the game app folder (Android/data/…), not Download/Downloads.'
    : ''
  throw new BridgeSaveNotFoundError(
    `Save file '${CIFI_SAVE_FILENAMES.join("' / '")}' not found via ADB scan.${physicalHint} Open CIFI, save your progress (Local Save), then try again.`,
    lastTried,
  )
}
