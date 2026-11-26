# FlowForm Windows 설치 파일과 업데이트 채널

설치 파일은 Windows 10 (빌드 19041 이상) 또는 Windows 11 x64에서 사용자 단위로 설치합니다. Python, Open CASCADE, Gmsh와 Windows 앱 구성이 포함됩니다. WebView2가 없는 PC에서는 설치 프로그램이 Microsoft 부트스트래퍼를 실행합니다. CFD용 OpenFOAM v14는 시작 메뉴의 **FlowForm - OpenFOAM setup**에서 Ubuntu 24.04 WSL에 설치합니다. WSL이 없는 PC에서는 관리자 터미널에서 wsl --install --no-distribution을 실행하고 Windows가 요청하면 재시작합니다. NVIDIA GPU 압력 가속에는 해당 Ubuntu 환경에서 별도 cuDSS 모듈 빌드가 필요합니다. 설치판 데이터는 %LOCALAPPDATA%\FlowFormInstalled에 보관됩니다.

## 빌드

64비트 Python 3.12 가상 환경에 requirements-cfd.txt, requirements-desktop.txt, installer/requirements-packaging.txt를 설치합니다. 공식 CPython 3.12.10 Windows x64 embeddable ZIP, Microsoft 서명 WebView2 부트스트래퍼, Inno Setup ISCC.exe 경로를 준비합니다. installer/build-windows.ps1에 EmbeddedPythonZip, WebView2Bootstrapper, InnoCompiler, RuntimeEnv, 새 BuildDirectory를 넘깁니다. 결과는 빌드 디렉터리의 dist 아래에 생깁니다.

## 새 버전 게시

HTTPS 서버에 설치 EXE와 서명한 release.json을 게시합니다.

1. cryptography가 설치된 Python으로 installer/publish_update.py init-key <개인 폴더의 키 경로.pem>을 실행합니다. 출력되는 값은 공개 키입니다. 개인 키는 배포 서버나 설치판에 넣지 않습니다.
2. build-windows.ps1에 Version, ManifestUrl, UpdatePublicKey를 전달해 설치 파일을 만듭니다. 기존 설치판은 %LOCALAPPDATA%\FlowFormInstalled\update-channel.json에 manifest_url과 public_key를 지정해도 됩니다.
3. installer/publish_update.py sign <키 경로> <설치 파일> <버전> <설치 파일 HTTPS 주소> <release.json 경로>로 서명된 매니페스트를 만듭니다. 설치 파일을 먼저 게시한 뒤 release.json을 올립니다. 버전은 설치 파일의 버전과 일치해야 합니다.
4. 앱의 **업데이트 확인**에서 새 버전을 승인하면 앱이 HTTPS로 내려받고 Ed25519 서명과 설치 파일의 SHA-256을 검증합니다. 진행 중인 해석이 없으면 설치 후 앱을 다시 엽니다.

Windows Authenticode 코드 서명과 릴리스 매니페스트 서명은 별개입니다. 현재 설치 파일은 Windows 코드 서명 인증서 없이 빌드했습니다.

