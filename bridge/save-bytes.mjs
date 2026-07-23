/** Reject adb shell stderr/stdout that was mistaken for a pulled save file. */
export function bytesLookLikeShellFailure(bytes) {
  if (!bytes?.byteLength) return true
  const sample = bytes.toString('utf8', 0, Math.min(bytes.byteLength, 512))
  return (
    /^cat:\s/m.test(sample)
    || /^adb:\s/m.test(sample)
    || /no such file|not found|permission denied|cannot open|is a directory/i.test(sample)
  )
}

/**
 * True when bytes are plausibly CIFI's DATA.text/CifiBackup.text (an ASCII base64 blob),
 * not an adb error string. Real saves are ~185KB+ of pure base64 charset.
 */
export function bytesLookLikeCifiSave(bytes) {
  if (!bytes?.byteLength || bytes.byteLength < 1000) return false
  if (bytesLookLikeShellFailure(bytes)) return false
  const sample = bytes.toString('utf8', 0, Math.min(bytes.byteLength, 512))
  return /^[A-Za-z0-9+/=\r\n]+$/.test(sample)
}
