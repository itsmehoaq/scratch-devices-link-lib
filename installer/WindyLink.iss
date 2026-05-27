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
UninstallDisplayIcon={app}\WindyLink.exe
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
Source: "..\dist\installer-payload\WindyLink.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\installer-payload\7za.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\installer-payload\firmwares\*"; DestDir: "{app}\firmwares"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\installer-payload\tools.7z"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "..\dist\installer-payload\node-v18.20.8-x64.msi"; DestDir: "{tmp}"; DestName: "node.msi"; Flags: deleteafterinstall

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\WindyLink.exe"; Comment: "Start Future Academy local hardware server"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\WindyLink.exe"; Tasks: desktopicon

[Registry]
Root: HKLM; Subkey: "Software\Windify\Future Academy"; ValueType: string; ValueName: "InstallPath"; ValueData: "{app}"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\Windify\Future Academy"; ValueType: string; ValueName: "ToolsPath"; ValueData: "{commonappdata}\Windify\Future Academy\tools"

[UninstallDelete]
Type: filesandordirs; Name: "{commonappdata}\Windify\Future Academy"

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

function ExtractTools: Boolean;
var
  ResultCode: Integer;
  ArchivePath: String;
  OutputDir: String;
begin
  ArchivePath := ExpandConstant('{tmp}\tools.7z');
  OutputDir := ExpandConstant('{commonappdata}\Windify\Future Academy');

  if not FileExists(ArchivePath) then
  begin
    MsgBox('Missing tools archive in installer payload.', mbError, MB_OK);
    Result := False;
    Exit;
  end;

  ForceDirectories(OutputDir);

  if not Exec(ExpandConstant('{app}\7za.exe'), ExpandConstant('x "' + ArchivePath + '" -o"' + OutputDir + '" -y'), '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    MsgBox('Failed to run 7-Zip to extract build tools.', mbError, MB_OK);
    Result := False;
    Exit;
  end;

  Result := (ResultCode = 0);
  if not Result then
    MsgBox(ExpandConstant('Tool extraction failed with exit code ' + IntToStr(ResultCode) + '.'), mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not EnsureNodeJs then
      Abort;

    if not ExtractTools then
      Abort;
  end;
end;
