; ============================================================================
;  CIFI Bridge - Windows installer (Inno Setup 6)
;
;  Build:  iscc /DMyAppVersion=1.0.1 cifi-bridge.iss
;  Output: dist/CifiBridgeSetup.exe
;
;  Design notes:
;  - PrivilegesRequired=lowest -> per-user install under %LOCALAPPDATA%, so
;    there is no UAC prompt and no "why does a save reader need admin?".
;  - The bootstrap ships inside this exe, so it carries no Mark-of-the-Web and
;    is not blocked the way a downloaded .cmd would be.
;  - No VBS launcher and no Run-key write. Background start is the bridge's own
;    --daemon mode (it re-spawns itself detached with windowsHide), registered
;    through Task Scheduler by `cifi-bridge --boot`. Scripts that write autorun
;    keys and launch hidden processes are what Defender's ML model scores as a
;    dropper; the sibling Tracker Bridge was flagged for exactly that shape.
;  - Unsigned builds still show SmartScreen once: "More info -> Run anyway".
; ============================================================================

#ifndef MyAppVersion
  #define MyAppVersion "1.0.1"
#endif

#define MyAppName "CIFI Bridge"
#define MyAppPublisher "CIFI Tools"
#define MyAppURL "https://github.com/TmRxJD/cifi-tools"
#define MyLauncher "cifi-bridge-launch.cmd"

[Setup]
AppId={{7FDAA26C-20A6-40AB-9D8C-CCE3037092A3}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\CifiBridge
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=CifiBridgeSetup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
UninstallDisplayName={#MyAppName}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Setup
VersionInfoProductName={#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &Desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
; Registers a Scheduled Task via `cifi-bridge --boot`, so the bridge is ready
; before you open the site. Off by default -- starting things at login should
; be a deliberate choice.
Name: "startup"; Description: "Start &CIFI Bridge when I sign in to Windows"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "bootstrap.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyLauncher}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyLauncher}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyLauncher}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; Install Node.js if needed, then the bridge itself.
Filename: "{cmd}"; Parameters: "/c ""{app}\bootstrap.cmd"" silent"; \
  StatusMsg: "Installing Node.js and CIFI Bridge..."; Flags: runhidden waituntilterminated

; Register the sign-in task only when the user asked for it. This calls the
; bridge's own --boot handler, which creates a Scheduled Task; nothing here
; writes to the registry.
Filename: "{cmd}"; Parameters: "/c ""{app}\{#MyLauncher}"" --boot-only --skip-intro"; \
  StatusMsg: "Registering start at sign-in..."; Flags: runhidden waituntilterminated; Tasks: startup

; Offer to start it now.
Filename: "{app}\{#MyLauncher}"; Description: "Start {#MyAppName} now"; \
  WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; Remove the Scheduled Task if one was registered. Ignores failure so an
; uninstall never blocks on an entry that was never created.
Filename: "{cmd}"; Parameters: "/c ""{app}\{#MyLauncher}"" --remove-boot --skip-intro"; \
  Flags: runhidden waituntilterminated; RunOnceId: "RemoveBootEntry"
Filename: "{cmd}"; Parameters: "/c npm uninstall -g cifi-bridge"; \
  Flags: runhidden waituntilterminated; RunOnceId: "UninstallGlobal"
