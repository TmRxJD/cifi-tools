"""Produce an AssetRipper Unity-project export of the game scene, for a chosen build.

The scene is where the game's authored definition data lives -- relic costs, talent and attribute
caps, badge and project tables -- none of which is in the save (it stores the player's LEVELS) or
in `dump.cs` (it gives field names and offsets, but no values). `extract-scene-defs.js` reads the
exported `MainSceneNew.unity`; this script is the step that produces it.

    CIFI_APK=apk-0.7.3.61 python tools/bench/export-scene.py
    python tools/bench/export-scene.py --keep-staging      # leave the staged folder for inspection

THREE THINGS MAKE THIS WORK, and each one silently produces an empty export if you get it wrong.
They are the reason this is a script rather than a paragraph of instructions:

  1. **The staged folder must be named `<something>_Data`.** That naming is what makes AssetRipper
     recognise the directory as a Unity build at all. Without it, it loads and exports cleanly and
     gives you ~4,800 objects of shaders and settings -- never the ~412,000 in the scene.
  2. **Export via `/Export/UnityProject`, NOT `/Export/PrimaryContent`.** `level0` is a SCENE, and
     scene contents never appear in primary content. Three earlier attempts exported zero purely
     because of this.
  3. **`level0.split*` must be concatenated in NUMERIC order.** A shell glob gives split0, split1,
     split10, split2, which yields a corrupt scene that still parses far enough to look plausible.

The DummyDlls from `il2cpp-dump/` must come from the SAME build as the assets: they are what lets
AssetRipper type the MonoBehaviour data, and mixing builds misreads fields rather than erroring.
"""

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")
GAMEFILES = os.path.join(HERE, "..", "gamefiles", APK_DIR)
SCRATCH = os.environ.get("HUNTERSIM_SCRATCH") or (
    r"B:\huntersim-re" if os.path.isdir("B:\\") else os.path.join(GAMEFILES, "scratch"))
ASSETRIPPER = os.path.join(SCRATCH, "assetripper", "AssetRipper.GUI.Free.exe")
STAGING = os.path.join(SCRATCH, f"stage-{APK_DIR}", "CIFI_Data")
EXPORT = os.path.join(SCRATCH, f"scene-export-{APK_DIR}")
PORT = int(os.environ.get("ASSETRIPPER_PORT", "47799"))

# Everything AssetRipper needs from the APK's assets/bin/Data. Split parts are reassembled.
WANTED = ("level0", "sharedassets0.assets", "globalgamemanagers", "globalgamemanagers.assets",
          "sharedassets0.resource")


def stage_from_apk():
    """Rebuild `<...>_Data/` out of base.apk, reassembling any split files in numeric order."""
    apk = os.path.join(GAMEFILES, "base.apk")
    if not os.path.exists(apk):
        raise SystemExit(f"missing {apk}")
    if os.path.isdir(STAGING):
        shutil.rmtree(STAGING)
    os.makedirs(STAGING)

    with zipfile.ZipFile(apk) as z:
        names = [n for n in z.namelist() if n.startswith("assets/bin/Data/")]
        for base in WANTED:
            prefix = f"assets/bin/Data/{base}"
            parts = [n for n in names if n == prefix or n.startswith(prefix + ".split")]
            if not parts:
                print(f"  (no {base} in the apk)", file=sys.stderr)
                continue
            # Numeric order by split index; the unsplit file sorts first.
            parts.sort(key=lambda n: -1 if n == prefix else int(n.rsplit("split", 1)[1]))
            out = os.path.join(STAGING, base)
            with open(out, "wb") as f:
                for p in parts:
                    f.write(z.read(p))
            print(f"  staged {base} ({os.path.getsize(out):,} bytes from {len(parts)} part(s))",
                  file=sys.stderr)

    # The DummyDlls type the MonoBehaviour data, and must match the build the assets came from.
    dummy = os.path.join(GAMEFILES, "il2cpp-dump", "DummyDll")
    if not os.path.isdir(dummy):
        raise SystemExit(f"missing {dummy} -- run the Il2CppDumper CLI for {APK_DIR} first "
                         "(see tools/il2cpp-cli/README.md)")
    managed = os.path.join(STAGING, "Managed")
    shutil.copytree(dummy, managed)
    print(f"  staged {len(os.listdir(managed))} DummyDll(s)", file=sys.stderr)


def post(path, **fields):
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, method="POST")
    with urllib.request.urlopen(req, timeout=7200) as r:
        return r.status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-staging", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(ASSETRIPPER):
        raise SystemExit(f"AssetRipper not found at {ASSETRIPPER}. Download the win_x64 build of "
                         "1.3.14 from github.com/AssetRipper/AssetRipper/releases and unzip it "
                         "there.")
    print(f"staging {APK_DIR} ->\n  {STAGING}", file=sys.stderr)
    stage_from_apk()

    if os.path.isdir(EXPORT):
        shutil.rmtree(EXPORT)
    os.makedirs(EXPORT)

    print(f"starting AssetRipper headless on :{PORT}", file=sys.stderr)
    log = open(os.path.join(SCRATCH, f"assetripper-{APK_DIR}.log"), "w", encoding="utf-8")
    proc = subprocess.Popen([ASSETRIPPER, "--headless", "--port", str(PORT)],
                            stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(60):  # wait for the local web API to accept connections
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=2).read()
                break
            except Exception:
                time.sleep(1)
        else:
            raise SystemExit("AssetRipper did not start listening")

        # LoadFolder gets the PARENT of the *_Data directory -- it is looking for a Unity build
        # layout, not for the data folder itself.
        print("  LoadFolder...", file=sys.stderr)
        post("/LoadFolder", Path=os.path.dirname(STAGING))
        print("  Export/UnityProject...", file=sys.stderr)
        post("/Export/UnityProject", Path=EXPORT)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()

    scenes = []
    for root, _, files in os.walk(EXPORT):
        for f in files:
            if f.endswith(".unity"):
                scenes.append(os.path.join(root, f))
    if not scenes:
        raise SystemExit(f"no .unity scene in {EXPORT} -- check "
                         f"{os.path.join(SCRATCH, f'assetripper-{APK_DIR}.log')}. An export that "
                         "'succeeds' with only a few thousand shader/settings objects means the "
                         "staged folder was not recognised as a Unity build (see this file's "
                         "docstring: the _Data suffix and UnityProject export are both load-bearing)")
    scenes.sort(key=os.path.getsize, reverse=True)
    for s in scenes:
        print(f"  {os.path.getsize(s):>14,}  {s}")
    if not args.keep_staging:
        shutil.rmtree(STAGING, ignore_errors=True)
    print(f"\nlargest scene:\n{scenes[0]}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
