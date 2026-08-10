# Headless IL2CPP dumper for CIFI

CIFI 0.7.3.54 is Unity **6000.3.8f1** with IL2CPP metadata **v39**. Perfare's Il2CppDumper caps at
v31 (checked against master, not just its last release, which is from 2024 and unmaintained).
AndnixSH's fork added v33/35/38/39 — but ships as a WPF app with no CLI, so it can't be scripted.

These three files are a console entry point around that fork. They add **no parsing logic**: the
fork's `Il2Cpp/`, `ExecutableFormats/`, `IO/`, `Utils/` and `Outputs/` sources are compiled in
unchanged, so upstream fixes come along for free on the next clone. Only the WPF coupling is
replaced.

- `Program.cs` — the console main (init → search → dump → DummyDll), mirroring the fork's
  `MainForm.Dump` minus the parts that need its `Settings`.
- `Shims.cs` — the fork's parsing files log through its window. Rather than edit their source,
  this supplies the two types they reach for: a stub `System.Windows.Media.Brushes`, and a
  `MainForm.Log` that writes to stdout. Also a `Resource1` that loads `Il2CppDummyDll.dll` from
  disk instead of a designer-generated resource.
- `Cli.csproj` — globs the fork's sources; `<Using Include="System.Windows.Media" />` because
  several of its files use `Brushes` without importing it (the WPF project had it implicitly).

## Build and run

```bash
git clone --depth 1 https://github.com/AndnixSH/Il2CppDumper-GUI.git dumpersrc
mkdir cli && cp tools/il2cpp-cli/* cli/          # csproj expects ../dumpersrc alongside
cd cli && dotnet build -c Release
./bin/Release/net8.0/Il2CppDumpCli.exe <libil2cpp.so> <global-metadata.dat> <outDir>
```

Outputs `dump.cs` and `DummyDll/`. **Note:** the fork writes `outputDir + "dump.cs"` without a
separator, so passing `out` produces `outdump.cs` next to the directory rather than inside it.
Pass a trailing separator, or just move the file afterwards.

Expect `ERROR: This file may be protected` on the way through — it is a warning from the ELF
loader, not a failure; the dump completes and CodeRegistration/MetadataRegistration resolve.

## What the dump does and does not give you

**Does:** every type, field (with offsets), method signature, property and enum in the game —
813k lines for CIFI, plus stub assemblies including `Assembly-CSharp.dll`.

**Does not:** method *bodies*. Il2CppDumper recovers structure and addresses, not code. Constants
computed in code are therefore still invisible; you would need Ghidra/IDA against `libil2cpp.so`
using the generated script, or typetrees (below) for serialized data.

**Typetrees:** the shipped assets have them stripped, so UnityPy reads MonoBehaviour headers but
not script fields. The `DummyDll/` output is what AssetRipper or AssetStudio need to reconstruct
them — that is the route to reading ScriptableObject balance data. **Attempted, not yet working:**

## AssetRipper attempt (1.3.14) — what worked and what did not

AssetRipper's free build is GUI-only, but `--headless --port N` hosts a local web API with an
OpenAPI spec at `/openapi.json`. It is fully scriptable that way, which is the reusable part:

```bash
AssetRipper.GUI.Free.exe --headless --port 47788 &
curl -X POST --data-urlencode "Path=<folder>"     http://127.0.0.1:47788/LoadFolder
curl -X POST --data-urlencode "Path=<outDir>"     http://127.0.0.1:47788/Export/PrimaryContent
```

(The `/LoadFile` and `/LoadFolder` forms in the UI open a native dialog and have no path field,
but the endpoints accept `Path` directly, which is what makes headless use possible at all.)

**It ran and exported cleanly — but produced ZERO MonoBehaviour assets in three configurations:**
`base.apk` alone; the folder holding both APKs plus `il2cpp-dump/DummyDll/` (it did pick those up
— "found 113 assemblies"); and a staged folder of the reassembled `level0` +
`sharedassets0.assets` + `globalgamemanagers` with the 113 dummy DLLs under `Managed/`.

Each run exported ~4,800 objects — shaders, settings, fonts — never the ~412,000 in `level0`. So
it is not ingesting the big asset files at all, rather than failing to type them. The likely
cause is that CIFI ships those files **split** inside the APK (`level0.split0`, `.split1`, …) and
the reassembly/layout is not what AssetRipper expects from a real Android build.

Next things to try, in rough order of promise: give it the on-device `/data/app` extraction
layout instead of a hand-built folder; try AssetStudio, which takes a plainer file list; or skip
both and parse the MonoBehaviour bytes directly using the field order and offsets `dump.cs`
already gives for `LoopModifiers`.
