# FlowForm Windows 설치 파일과 업데이트 채널

설치 파일은 Windows 10 (빌드 19041 이상) 또는 Windows 11 x64에서 사용자 단위로 설치합니다. Python, Open CASCADE, Gmsh와 Windows 앱 구성이 포함됩니다. WebView2가 없는 PC에서는 설치 프로그램이 Microsoft 부트스트래퍼를 실행합니다. CFD용 OpenFOAM v14는 시작 메뉴의 **FlowForm - OpenFOAM setup**에서 Ubuntu 24.04 WSL에 설치합니다. WSL이 없는 PC에서는 관리자 터미널에서 wsl --install --no-distribution을 실행하고 Windows가 요청하면 재시작합니다. NVIDIA GPU 압력 가속에는 해당 Ubuntu 환경에서 별도 cuDSS 모듈 빌드가 필요합니다. 설치판 데이터는 %LOCALAPPDATA%\FlowFormInstalled에 보관됩니다.

## 빌드

64비트 Python 3.12 가상 환경에 requirements-cfd.txt, requirements-desktop.txt, installer/requirements-packaging.txt를 설치합니다. 공식 CPython 3.12.10 Windows x64 embeddable ZIP, Microsoft 서명 WebView2 부트스트래퍼, Inno Setup ISCC.exe 경로를 준비합니다. installer/build-windows.ps1에 EmbeddedPythonZip, WebView2Bootstrapper, InnoCompiler, RuntimeEnv, 새 BuildDirectory를 넘깁니다. 결과는 빌드 디렉터리의 dist 아래에 생깁니다.

## 새 버전 게시

버전 형식은 `주.부.패치`입니다. 호환성을 깨는 변경은 주 버전, 주요 기능 추가와 작업공간 개편은 부 버전, 작은 수정은 패치 버전으로 구분합니다. 공개 버전은 중복 사용하지 않습니다.

이번 UI 개편 버전은 `0.2.1`입니다. GitHub 태그는 `v0.2.1`, 릴리스 제목은 `FlowForm v0.2.1 — UI 개선`, 설치 파일은 `FlowForm-0.2.1-Windows-x64-Setup.exe`, 소스 파일은 `FlowForm-0.2.1-Source.zip`입니다. 앱 제목 표시줄과 업데이트 정보에는 설치 파일을 빌드할 때 지정한 버전이 표시됩니다.

GitHub Releases 초안에 설치 파일, 대응 소스 파일, 서명한 `release.json`을 함께 올린 뒤 최신 릴리스로 게시합니다.

1. 채널을 처음 만들 때만 `installer/publish_update.py init-key`로 서명 키를 생성합니다. 이후 릴리스에서도 같은 개인 키로 서명합니다. 개인 키는 배포 서버나 설치판에 넣지 않습니다.
2. `build-windows.ps1`에 `Version`, `ManifestUrl`, `UpdatePublicKey`를 전달합니다. 공개판의 `ManifestUrl`은 `https://github.com/teho00/flowform-releases/releases/latest/download/release.json`입니다.
3. `installer/publish_update.py sign <키 경로> <설치 파일> <버전> <설치 파일 HTTPS 주소> <release.json 경로>`로 업데이트 정보에 서명합니다. 설치 파일 주소에는 버전별 GitHub 태그를 사용합니다. 태그, 설치 파일 이름, 내부 버전이 같은 번호인지 확인한 뒤 게시합니다.
4. 앱의 **업데이트 확인**에서 새 버전을 승인하면 앱이 HTTPS로 내려받고 Ed25519 서명과 설치 파일의 SHA-256을 검증합니다. 진행 중인 해석이 없으면 설치 후 앱을 다시 엽니다.

Windows Authenticode 코드 서명과 릴리스 매니페스트 서명은 별개입니다. 현재 설치 파일은 Windows 코드 서명 인증서 없이 빌드했습니다.

