# Game files (local only, never committed)

Ground truth for anything the live cifi-tools bundle leaves ambiguous. The bundle is one
author's reading of the game; these files *are* the game. When the two disagree, this wins —
but note the app deliberately matches the ORIGINAL TOOL's behaviour where the two differ in a
user-visible way (see CLAUDE.md), so a disagreement is a decision to make, not automatically a
bug to fix.

Everything under this directory is gitignored: the APKs are ~235 MB combined and are not ours
to redistribute. This README is the only committed part.

## What's here

```
apk-<version>/
  base.apk                     the app
  split_config.x86_64.apk      native libs for the emulator's ABI
  extracted/
    global-metadata.dat        IL2CPP metadata (type/method/string tables)
    libil2cpp.so               compiled managed code
save/
  DATA-<yyyymmdd>.text         the live save
  CifiBackup-<yyyymmdd>.text   the game's own rolling backup
```

Current copy: **CIFI 0.7.3.54** (versionCode 1300), pulled 2026-08-09 from an emulator running
`com.OctocubeGamesCompany.CIFI`.

## Re-pulling

Needs an emulator with root (`su`) and adb. `MSYS_NO_PATHCONV=1` matters under Git Bash —
without it, Bash rewrites `/sdcard/...` into a Windows path and adb reports "failed to stat
remote object".

```bash
export PATH="$PATH:$LOCALAPPDATA/Android/Sdk/platform-tools"
export MSYS_NO_PATHCONV=1
adb connect 127.0.0.1:5555
D=127.0.0.1:5555
PKG=com.OctocubeGamesCompany.CIFI

# APKs
adb -s $D shell pm path $PKG            # gives the two /data/app paths
adb -s $D pull "<base.apk path>"        tools/gamefiles/apk-<ver>/base.apk
adb -s $D pull "<split path>"           tools/gamefiles/apk-<ver>/split_config.x86_64.apk

# Save. Copy to /sdcard first (the app's external dir is not world-readable), then PULL --
# do NOT `adb shell cat` it: adb translates LF to CRLF and silently corrupts the file
# (observed: 199705 bytes on device came back as 199709).
adb -s $D shell "su -c 'cp /storage/emulated/0/Android/data/$PKG/files/DATA.text /sdcard/_d.text; chmod 666 /sdcard/_d.text'"
adb -s $D pull /sdcard/_d.text tools/gamefiles/save/DATA-$(date +%Y%m%d).text
adb -s $D shell "su -c 'rm -f /sdcard/_d.text'"
```

Verify the pulled size matches the on-device size before trusting it.

## Decompiling

`extracted/` holds the pair Il2CppDumper needs (`global-metadata.dat` + `libil2cpp.so`).
Feed both to Il2CppDumper to recover type and method names, then AssetRipper or UnityPy over
`base.apk`'s `assets/bin/Data/` for the serialized data assets.

`tools/save/` has the existing string/name extraction scripts.
