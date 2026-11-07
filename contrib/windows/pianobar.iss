; Inno Setup 6 script for pianobar-windows.
; Built by .github/workflows/release.yml:
;   ISCC.exe /DAppVersion=<tag> /DArch=<x64|x86> /DStageDir=<dir with pianobar.exe + docs> /DOutputDir=<dir> contrib\windows\pianobar.iss

#ifndef AppVersion
  #define AppVersion "dev"
#endif
#ifndef Arch
  #define Arch "x64"
#endif
#ifndef StageDir
  #error StageDir must be defined (directory holding pianobar.exe and the docs)
#endif
#ifndef OutputDir
  #define OutputDir "dist"
#endif

[Setup]
AppId={{7A1B2C3D-9E8F-4A5B-8C6D-PIANOBARWIN1}
AppName=pianobar
AppVersion={#AppVersion}
AppVerName=pianobar {#AppVersion}
AppPublisher=Spaceghost
AppPublisherURL=https://github.com/Spaceghost/pianobar-windows
AppSupportURL=https://github.com/Spaceghost/pianobar-windows/issues
AppUpdatesURL=https://github.com/Spaceghost/pianobar-windows/releases
DefaultDirName={autopf}\pianobar
DefaultGroupName=pianobar
DisableProgramGroupPage=yes
LicenseFile={#StageDir}\COPYING
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutputDir}
OutputBaseFilename=pianobar-windows-{#AppVersion}-setup-win-{#Arch}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
UninstallDisplayIcon={app}\pianobar.exe
#if Arch == "x64"
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "addtopath"; Description: "Add pianobar to the user PATH"; GroupDescription: "Environment:"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#StageDir}\pianobar.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\pianobar.cfg.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme
Source: "{#StageDir}\COPYING"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\LICENSE.libpiano"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\pianobar"; Filename: "{app}\pianobar.exe"; WorkingDir: "{app}"; Comment: "Console Pandora client"
Name: "{group}\pianobar folder (config lives here)"; Filename: "{app}"
Name: "{group}\Uninstall pianobar"; Filename: "{uninstallexe}"
Name: "{autodesktop}\pianobar"; Filename: "{app}\pianobar.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Tasks: addtopath; Check: NeedsAddPath(ExpandConstant('{app}'))

[Run]
Filename: "{win}\explorer.exe"; Parameters: """{app}"""; Description: "Open the install folder to create pianobar.cfg"; Flags: postinstall nowait skipifsilent unchecked

[Code]
const
  EnvKey = 'Environment';

function NeedsAddPath(Dir: string): Boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  { look for the path surrounded by semicolons to avoid partial matches }
  Result := Pos(';' + Lowercase(Dir) + ';', ';' + Lowercase(OrigPath) + ';') = 0;
end;

procedure RemoveFromPath(Dir: string);
var
  OrigPath, NewPath: string;
  P: Integer;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', OrigPath) then
    exit;
  NewPath := ';' + OrigPath + ';';
  P := Pos(';' + Lowercase(Dir) + ';', Lowercase(NewPath));
  if P = 0 then
    exit;
  Delete(NewPath, P, Length(Dir) + 1);
  { strip the sentinel semicolons added above }
  if (Length(NewPath) > 0) and (NewPath[1] = ';') then
    Delete(NewPath, 1, 1);
  if (Length(NewPath) > 0) and (NewPath[Length(NewPath)] = ';') then
    Delete(NewPath, Length(NewPath), 1);
  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', NewPath);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    { SuppressibleMsgBox, not MsgBox: a plain MsgBox ignores /SUPPRESSMSGBOXES and blocks a
      /VERYSILENT install forever (CI smoke run 42099849538 hung here for 38 minutes). }
    if not FileExists(ExpandConstant('{app}\pianobar.cfg')) then
      SuppressibleMsgBox('pianobar reads its configuration from pianobar.cfg next to pianobar.exe:' + #13#10 +
             ExpandConstant('{app}\pianobar.cfg') + #13#10#13#10 +
             'Copy pianobar.cfg.example to pianobar.cfg in that folder and fill in your Pandora user and password before the first run.',
             mbInformation, MB_OK, IDOK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveFromPath(ExpandConstant('{app}'));
end;
