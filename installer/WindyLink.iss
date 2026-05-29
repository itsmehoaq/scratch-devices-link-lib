#define AppName "Future Academy"
#define AppPublisher "Windify"
#define AppURL "https://stem.windify.edu.vn/"
#ifndef AppVersion
  #define AppVersion "0.2.0"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "FutureAcademy-0.2.0-x64-setup"
#endif

[Setup]
AppId={{A7B3C4D5-E6F7-4890-ABCD-123456789ABC}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf64}\Future Academy
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename={#OutputBaseFilename}
SetupIconFile=..\assets\FutureAcademy.ico
#ifdef GuiBuild
UninstallDisplayIcon={app}\FutureAcademy.ico
#else
UninstallDisplayIcon={app}\WindyLink.exe
#endif
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
#ifdef GuiBuild
Source: "..\dist\installer-payload\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
#else
Source: "..\dist\installer-payload\WindyLink.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\installer-payload\7za.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\installer-payload\firmwares\*"; DestDir: "{app}\firmwares"; Flags: ignoreversion recursesubdirs createallsubdirs
#endif
Source: "..\dist\installer-payload\7za.exe"; DestDir: "{tmp}"; DestName: "7za.exe"; Flags: deleteafterinstall
Source: "..\dist\installer-payload\tools.7z"; DestDir: "{tmp}"; Flags: deleteafterinstall
#ifndef GuiBuild
Source: "..\dist\installer-payload\node-v18.20.8-x64.msi"; DestDir: "{tmp}"; DestName: "node.msi"; Flags: deleteafterinstall
#endif

[Icons]
#ifdef GuiBuild
Name: "{group}\{#AppName}"; Filename: "{app}\WindyLink.exe"; IconFilename: "{app}\FutureAcademy.ico"; Comment: "Start Future Academy local hardware server"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\WindyLink.exe"; IconFilename: "{app}\FutureAcademy.ico"; Tasks: desktopicon
#else
Name: "{group}\{#AppName}"; Filename: "{app}\WindyLink.exe"; Comment: "Start Future Academy local hardware server"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\WindyLink.exe"; Tasks: desktopicon
#endif

[Registry]
Root: HKLM; Subkey: "Software\Windify\Future Academy"; ValueType: string; ValueName: "InstallPath"; ValueData: "{app}"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\Windify\Future Academy"; ValueType: string; ValueName: "ToolsPath"; ValueData: "{commonappdata}\Windify\Future Academy\tools"

[UninstallDelete]
Type: filesandordirs; Name: "{commonappdata}\Windify\Future Academy"

[Run]
Filename: "{tmp}\7za.exe"; Parameters: "x ""{tmp}\tools.7z"" -o""{commonappdata}\Windify\Future Academy"" -y"; WorkingDir: "{tmp}"; StatusMsg: "Extracting build tools (this may take a few minutes)..."; Flags: runhidden waituntilterminated; Check: ShouldExtractTools

[Code]
function GetNodeVersion: String;
var
  Version: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Node.js', 'Version', Version) then
    Result := Version
  else if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Node.js', 'Version', Version) then
    Result := Version;
end;

function NodeVersionAtLeast(MinMajor: Integer): Boolean;
var
  Version: String;
  MajorStr: String;
  DotPos: Integer;
  Major: Integer;
begin
  Result := False;
  Version := GetNodeVersion;
  if Version = '' then
    Exit;

  if (Length(Version) > 0) and (Version[1] = 'v') then
    Delete(Version, 1, 1);

  DotPos := Pos('.', Version);
  if DotPos > 1 then
    MajorStr := Copy(Version, 1, DotPos - 1)
  else
    MajorStr := Version;

  Major := StrToIntDef(MajorStr, 0);
  Result := Major >= MinMajor;
end;

#ifdef GuiBuild
function EnsureNodeJs: Boolean;
begin
  { Electron GUI bundles its own Node runtime; no system Node.js MSI. }
  Result := True;
end;
#else
function EnsureNodeJs: Boolean;
var
  ResultCode: Integer;
  NodeMsi: String;
begin
  if NodeVersionAtLeast(18) then
  begin
    Result := True;
    Exit;
  end;

  NodeMsi := ExpandConstant('{tmp}\node.msi');
  if not FileExists(NodeMsi) then
  begin
    MsgBox('Missing Node.js installer payload.', mbError, MB_OK);
    Result := False;
    Exit;
  end;

  if not Exec('msiexec.exe', ExpandConstant('/i "' + NodeMsi + '" /qn /norestart ADDLOCAL=ALL'), '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    MsgBox('Failed to launch Node.js installer.', mbError, MB_OK);
    Result := False;
    Exit;
  end;

  Result := (ResultCode = 0) or (ResultCode = 3010);
  if not Result then
    MsgBox(ExpandConstant('Node.js installer failed with exit code ' + IntToStr(ResultCode) + '.'), mbError, MB_OK);
end;
#endif

function ShouldExtractTools: Boolean;
begin
  ForceDirectories(ExpandConstant('{commonappdata}\Windify\Future Academy'));
  Result := not FileExists(ExpandConstant('{commonappdata}\Windify\Future Academy\tools\Arduino\arduino-cli.exe'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not EnsureNodeJs then
      Abort;
  end;
end;
