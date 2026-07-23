/** CIFI's real (only known) package id, confirmed via `adb shell pm list packages`. */
export const CIFI_ANDROID_PACKAGE = 'com.OctocubeGamesCompany.CIFI'
export const CIFI_ANDROID_PACKAGES = [CIFI_ANDROID_PACKAGE]

/** Primary save + its rolling backup, both confirmed present on-device. */
export const CIFI_SAVE_FILENAME = 'DATA.text'
export const CIFI_BACKUP_FILENAME = 'CifiBackup.text'
export const CIFI_SAVE_FILENAMES = [CIFI_SAVE_FILENAME, CIFI_BACKUP_FILENAME]

function externalPaths(pkg, filename) {
  return [
    `/storage/emulated/0/Android/data/${pkg}/files/${filename}`,
    `/sdcard/Android/data/${pkg}/files/${filename}`,
    `/mnt/sdcard/Android/data/${pkg}/files/${filename}`,
  ]
}

export const CIFI_INTERNAL_SAVE_PATH = `/data/data/${CIFI_ANDROID_PACKAGE}/files/${CIFI_SAVE_FILENAME}`
export const CIFI_INTERNAL_BACKUP_PATH = `/data/data/${CIFI_ANDROID_PACKAGE}/files/${CIFI_BACKUP_FILENAME}`

/** @returns {string[]} De-duplicated external-storage pull paths, primary save first. */
export function buildSavePullPaths() {
  const seen = new Set()
  const paths = []
  const add = value => {
    if (seen.has(value)) return
    seen.add(value)
    paths.push(value)
  }
  for (const pkg of CIFI_ANDROID_PACKAGES) {
    for (const remotePath of externalPaths(pkg, CIFI_SAVE_FILENAME)) add(remotePath)
  }
  for (const pkg of CIFI_ANDROID_PACKAGES) {
    for (const remotePath of externalPaths(pkg, CIFI_BACKUP_FILENAME)) add(remotePath)
  }
  return paths
}

/** Emulator/USB bridge pulls use the same path order (no legacy Downloads-folder era to match). */
export const buildEmulatorPullPaths = buildSavePullPaths

/** Known emulator ADB TCP ports/hosts worth auto-connecting to before scanning `adb devices`. */
export const KNOWN_EMULATOR_ADB_HOSTS = [
  '127.0.0.1:7555',
  '127.0.0.1:16384',
  '127.0.0.1:5555',
  '127.0.0.1:5556',
  '127.0.0.1:5557',
  '127.0.0.1:5558',
  '127.0.0.1:5559',
  '127.0.0.1:21503',
  '127.0.0.1:62001',
]
