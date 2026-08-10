# Capturing CIFI's server-side tables

## Why a capture is needed at all

Loop mods ("modules") are **not in the APK and not in the save**, and that is established rather
than assumed:

- `Stelzi` appears **zero** times in the 813k-line IL2CPP dump and zero times in the metadata
  string table. Only the handful of mod effects that touch hunter simulation exist client-side,
  as plain properties (`TrampleBorge`, `ScavengersAdvantage`) — the *definitions* do not.
- The save carries only aggregates (`AllTimeHighestLoopModLevels`, `LoopModLevelsThisTraversal`),
  with no per-mod entries. **So diffing saves cannot recover them either** — there is nothing
  per-mod in a save to diff.

The backend is **Nakama** (`NakamaConfig : ScriptableObject` in the dump) — open-source, with a
documented protocol (storage objects over HTTP/JSON plus a realtime WebSocket). That is what
makes the capture interpretable instead of a second reverse-engineering project.

The collection/key paths live in a runtime `Dictionary<CloudSaveMode, CollectionKeyPath>` built in
a constructor, so they are not statically readable from the dump — watching one fetch is the
shortest path to them.

## Why a proxy and not Frida

Frida injects into the process and CIFI ships ACTk (`ACTk.Runtime.dll` in the dump — Anti-Cheat
Toolkit), so injection risks tripping tamper detection. A proxy touches nothing in the process:
the app makes ordinary TLS connections and a local proxy terminates them. Nothing is patched,
nothing is injected.

Checked before relying on this: the dump contains **no certificate pinning** — only standard
Mono/Unity TLS machinery (`ChainValidationHelper`, `SslPolicyErrors`), no custom
`CertificateHandler` override and no pinning library. A system-trusted CA is therefore sufficient.

## Step 1 — install the CA (you must do this part)

Adding a root CA to a device trust store is a security-settings change, so run this yourself.
The emulator is Android 12 / SDK 32, which still uses the simple `/system/etc/security/cacerts`
store — no Conscrypt APEX workaround needed.

`~/.mitmproxy/c8750f0d.0` is mitmproxy's CA already named by its subject hash, which is the name
Android's store requires.

```bash
export PATH="$PATH:$LOCALAPPDATA/Android/Sdk/platform-tools"
export MSYS_NO_PATHCONV=1          # or Git Bash rewrites /sdcard into a Windows path
D=127.0.0.1:5555
adb -s $D push ~/.mitmproxy/c8750f0d.0 /sdcard/c8750f0d.0
adb -s $D shell "su -c 'mount -o rw,remount /system && cp /sdcard/c8750f0d.0 /system/etc/security/cacerts/ && chmod 644 /system/etc/security/cacerts/c8750f0d.0 && mount -o ro,remount /system'"
adb -s $D shell "ls -l /system/etc/security/cacerts/c8750f0d.0"
```

To undo afterwards:

```bash
adb -s $D shell "su -c 'mount -o rw,remount /system && rm /system/etc/security/cacerts/c8750f0d.0 && mount -o ro,remount /system'"
```

## Step 2 — capture

```bash
mkdir -p tools/gamefiles/capture
mitmdump -s tools/capture/nakama_capture.py -w tools/gamefiles/capture/flows.mitm --listen-port 8080
```

Point the device at the proxy (`10.0.2.2` is the host from inside this emulator), then restart the
game so it performs a fresh login and table fetch:

```bash
adb -s $D shell "settings put global http_proxy 10.0.2.2:8080"
adb -s $D shell "am force-stop com.OctocubeGamesCompany.CIFI"
adb -s $D shell "monkey -p com.OctocubeGamesCompany.CIFI -c android.intent.category.LAUNCHER 1"
```

Let it reach the main screen, then open the Loop Mods / Ouroboros screens — tables are often
fetched lazily on first view, so a login-only capture can miss them.

Clear the proxy when finished, or the device has no network once mitmdump stops:

```bash
adb -s $D shell "settings put global http_proxy :0"
```

## Step 3 — read the results

The addon writes two files next to the flow:

- `nakama-calls.json` — every Nakama request/response, **redacted** (auth tokens, session,
  device id, long opaque blobs). Safe to read and to share.
- `nakama-tables.json` — just the storage objects, with Nakama's doubly-encoded `value` field
  decoded, keyed `collection/key`. This is the part a future gem/mod planner consumes.

`tools/gamefiles/` is gitignored in full. **Do not commit `flows.mitm`** — unlike the distilled
output it is raw and contains live session credentials.

## If nothing appears

- Traffic but no `/v2/` paths: the client may use Nakama's gRPC port rather than HTTP. Check
  `nakama-calls.json` for the hosts seen, and add the port to mitmproxy's `--mode` accordingly.
- No traffic at all: the proxy setting does not apply to every app on every Android build. Fall
  back to a transparent redirect with `iptables`, or check that mitmdump is listening on the
  interface `10.0.2.2` maps to.
- TLS errors in mitmdump: the CA is not being trusted — re-check step 1 landed the file with mode
  644 and that the app was fully restarted afterwards.
