; DRAMATIS Studio — Windows installer (Inno Setup).
; Build with installer\build-installer.ps1 (stages tracked files via git archive,
; so a stray .env or out\ render can never end up inside the EXE).
;
; The EXE ships ONLY the app (~5 MB). Engines and models are downloaded on the
; user's machine by installer\bootstrap.ps1 — deliberately, because the Python
; voice stack pulls GPL-licensed pieces we can distribute a DOWNLOADER for, but
; not redistribute ourselves inside an Apache-2.0 installer.

#define MyAppName "DRAMATIS Studio"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Machine King Labs"
#define MyAppURL "https://github.com/taskmasterpeace/dramatis-audiobook-studio"

[Setup]
AppId={{7E1D3A52-9C41-4A8B-B7E0-DRAMATIS0100}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
DefaultDirName={autopf}\DRAMATIS
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=DRAMATIS-Setup-{#MyAppVersion}
SetupIconFile=dramatis.ico
UninstallDisplayIcon={app}\installer\dramatis.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "staging\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs
Source: "staging\installer\launch.cmd"; DestDir: "{app}"; DestName: "DRAMATIS Studio.cmd"

[Icons]
Name: "{userprograms}\DRAMATIS Studio"; Filename: "{app}\DRAMATIS Studio.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\installer\dramatis.ico"
Name: "{userdesktop}\DRAMATIS Studio"; Filename: "{app}\DRAMATIS Studio.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\installer\dramatis.ico"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"""; Description: "Download engines && voice models now (~700 MB, one time — recommended)"; Flags: postinstall runasoriginaluser
Filename: "{app}\DRAMATIS Studio.cmd"; Description: "Launch DRAMATIS Studio"; Flags: postinstall shellexec nowait runasoriginaluser unchecked

[UninstallDelete]
; downloaded pieces the uninstaller wouldn't otherwise know about.
; {app}\out is deliberately NOT here — that's the user's produced audiobooks.
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\.venv"
Type: filesandordirs; Name: "{app}\models"
Type: filesandordirs; Name: "{app}\.bootstrap-done"
