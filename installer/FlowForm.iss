#ifndef ReleaseVersion
  #define ReleaseVersion "0.1.0"
#endif

[Setup]
AppId={{3F6A280A-4682-4A2D-A84A-69AA3AE0961B}
AppName=FlowForm
AppVersion={#ReleaseVersion}
AppPublisher=FlowForm
DefaultDirName={localappdata}\Programs\FlowForm
DefaultGroupName=FlowForm
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir=..\..\dist
OutputBaseFilename=FlowForm-{#ReleaseVersion}-Windows-x64-Setup
SetupIconFile=..\..\payload\app\channel_ui\flowform.ico
UninstallDisplayIcon={app}\app\channel_ui\flowform.ico
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#ReleaseVersion}

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
korean.DesktopTask=바탕화면에 FlowForm 바로가기 만들기
english.DesktopTask=Create a FlowForm desktop shortcut
korean.LaunchApp=FlowForm 실행
english.LaunchApp=Start FlowForm
korean.SetupSolver=OpenFOAM v14 설치 도우미 실행
english.SetupSolver=Start the OpenFOAM v14 setup helper
korean.WebViewMissing=Microsoft Edge WebView2를 설치하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.
english.WebViewMissing=Microsoft Edge WebView2 could not be installed. Check your Internet connection and retry.

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopTask}"; Flags: unchecked

[Files]
Source: "..\..\payload\runtime\*"; DestDir: "{app}\runtime"; Excludes: "*.pyc"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\payload\app\*"; DestDir: "{app}\app"; Excludes: "*.pyc"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\payload\MicrosoftEdgeWebview2Setup.exe"; Flags: dontcopy

[Icons]
Name: "{group}\FlowForm"; Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\app\installed_launch.py"""; WorkingDir: "{app}"; IconFilename: "{app}\app\channel_ui\flowform.ico"
Name: "{group}\FlowForm - OpenFOAM setup"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File ""{app}\app\setup-openfoam.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\app\channel_ui\flowform.ico"
Name: "{group}\FlowForm - 설치 안내"; Filename: "{app}\app\설치안내.txt"
Name: "{autodesktop}\FlowForm"; Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\app\installed_launch.py"""; WorkingDir: "{app}"; IconFilename: "{app}\app\channel_ui\flowform.ico"; Tasks: desktopicon

[InstallDelete]
Type: files; Name: "{autodesktop}\FlowForm (설치판).lnk"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File ""{app}\app\setup-openfoam.ps1"""; Description: "{cm:SetupSolver}"; Flags: postinstall skipifsilent unchecked nowait
Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\app\installed_launch.py"""; WorkingDir: "{app}"; Description: "{cm:LaunchApp}"; Flags: postinstall skipifsilent nowait

Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\app\installed_launch.py"""; WorkingDir: "{app}"; Flags: nowait; Check: IsFlowFormUpdate

[Code]
function IsFlowFormUpdate: Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/FLOWFORMUPDATE') = 0 then
    begin
      Result := True;
      exit;
    end;
end;

function HasRuntime(Hive: Integer): Boolean;
var
  V: String;
begin
  Result := RegQueryStringValue(Hive,
    'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V)
    and (V <> '') and (V <> '0.0.0.0');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if HasRuntime(HKLM32) or HasRuntime(HKCU) then exit;
  ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
  if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode)
    or (ResultCode <> 0) then
    Result := ExpandConstant('{cm:WebViewMissing}');
end;


