# Capturing CIFI's server-side tables

## CORRECTION: loop mods do NOT need this capture

An earlier version of this file said loop mods were server-side and that save diffing could not
recover them. **Both claims were wrong.**

- **Levels are in the save**: `LM<N>Level` (295 entries) and `LMOuro<N>Level` (39). The original
  search looked for `LoopMod`; the save abbreviates to **LM**.
- **Definitions are in the client**: `LoopModifiers` in the IL2CPP dump carries per-mod
  `StartCost`, `CostExponent`, `AdditiveCostIncrease`, `Bonus`, `BonusExponent`, `MaxLevel`.
- The bad inference: `Stelzi` appears zero times in the client, so the table "must" be remote.
  But `stelzi` is cifi-tools' own internal id, not a game string — our `hunterDefs.js` calls that
  mod "Mutual Mining Agreement". Absence of a nickname the game never used proved nothing.

What is still blocked is reading the *values* of those definition fields: they are serialized
MonoBehaviour data and this build strips typetrees, so the route is AssetRipper with the
`DummyDll/` the dumper produced — **not** a network capture.

## What this harness is still good for

Anything genuinely server-side: leaderboards (`NakamaConfig` names nine of them), cloud-save
collection paths (built in a runtime dictionary and so not statically readable), ban/time/score
RPC ids, and whatever else the client fetches rather than ships. If a future tool needs those,
this is ready. It is **not** the path to loop mods.

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
