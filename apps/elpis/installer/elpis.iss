; Inno Setup 6 script for Elpis (melodica.h mirror).
; Built by .github/workflows/release.yml:
;   ISCC.exe /DAppVersion=<tag> /DNumVersion=<x.y.z> /DSourceDir=<staged files> /DOutputDir=dist installer\elpis.iss
; SourceDir must hold exactly the file set that goes into the portable zip.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef NumVersion
  #define NumVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\stage\elpis-" + AppVersion + "-win-x86"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

[Setup]
AppId={{8ED4C6C9-0E11-49FC-8C29-5FA453E72912}
AppName=Elpis
AppVersion={#AppVersion}
AppVerName=Elpis {#AppVersion}
AppPublisher=Spaceghost/elpis-melodica
AppPublisherURL=https://github.com/Spaceghost/elpis-melodica
AppSupportURL=https://github.com/Spaceghost/elpis-melodica
AppUpdatesURL=https://github.com/Spaceghost/elpis-melodica/releases
VersionInfoVersion={#NumVersion}
DefaultDirName={autopf}\Elpis
DefaultGroupName=Elpis
UninstallDisplayIcon={app}\Elpis.exe
UninstallDisplayName=Elpis
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x86compatible
OutputDir={#OutputDir}
OutputBaseFilename=elpis-{#AppVersion}-setup-win-x86
SetupIconFile=..\Elpis\Resources\main_icon.ico
LicenseFile={#SourceDir}\License.txt
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Elpis"; Filename: "{app}\Elpis.exe"; WorkingDir: "{app}"
Name: "{group}\Uninstall Elpis"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Elpis"; Filename: "{app}\Elpis.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Elpis.exe"; Description: "{cm:LaunchProgram,Elpis}"; Flags: nowait postinstall skipifsilent

[Code]
// .NET Framework 4.6 or newer: Release value >= 393295 (4.6 RTM).
const
  NetFx46Release = 393295;
  NetFxUrl = 'https://dotnet.microsoft.com/download/dotnet-framework';

function NetFx46OrLater(): Boolean;
var
  Release: Cardinal;
begin
  Result := False;
  if RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', 'Release', Release) then
    Result := Release >= NetFx46Release;
end;

function InitializeSetup(): Boolean;
var
  ErrorCode: Integer;
begin
  Result := NetFx46OrLater();
  if not Result then
  begin
    if MsgBox('Elpis needs the Microsoft .NET Framework 4.6 or newer, which is not installed.' + #13#10#13#10 +
              'It is built into Windows 10 and 11. On older Windows, download it from:' + #13#10 +
              NetFxUrl + #13#10#13#10 +
              'Open the download page now?', mbError, MB_YESNO) = IDYES then
      ShellExec('open', NetFxUrl, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
  end;
end;
