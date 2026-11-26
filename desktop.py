"""Open FlowForm in a standalone Windows window backed by Edge WebView2."""

import argparse
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener


ROOT = Path(__file__).resolve().parent
PROFILE = Path(os.environ["FLOWFORM_PROFILE_DIR"]) if "FLOWFORM_PROFILE_DIR" in os.environ else (
    Path(os.environ.get("LOCALAPPDATA", Path.home())) / "FlowForm"
)
LOOPBACK = build_opener(ProxyHandler({}))


def server_ready(url):
    try:
        with LOOPBACK.open(url + "/flow", timeout=1) as response:
            return b"<title>OpenFOAM CFD" in response.read(8192)
    except (OSError, URLError):
        return False


def ensure_server(url, port, runs_dir):
    if server_ready(url):
        return
    log_path = PROFILE / "server.log"
    python = Path(sys.executable).with_name("python.exe")
    command = [str(python), str(ROOT / "app.py"), "--port", str(port), "--runs-dir", str(runs_dir)]
    with log_path.open("ab") as log:
        server = subprocess.Popen(
            command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if server_ready(url):
            return
        if server.poll() is not None:
            break
        time.sleep(0.2)
    raise RuntimeError(f"로컬 해석 서비스를 시작할 수 없습니다.\n{log_path}")


def main():
    import webview

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--runs-dir", type=Path, default=ROOT / "runs")
    parser.add_argument("--page", choices=("flow", "cad"), default="flow")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port 값은 1~65535 범위여야 합니다.")
    PROFILE.mkdir(parents=True, exist_ok=True)
    url = f"http://127.0.0.1:{args.port}"
    ensure_server(url, args.port, args.runs_dir.resolve())

    release_config = ROOT / "update-release.json"
    title = "FlowForm · CAD & CFD"
    if release_config.is_file():
        try:
            installed_version = json.loads(release_config.read_text(encoding="utf-8-sig"))["current_version"]
        except (OSError, ValueError, KeyError, TypeError):
            pass
        else:
            if isinstance(installed_version, str):
                title = f"FlowForm v{installed_version} · CAD & CFD"

    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("FlowForm.CadCfd")
    webview.settings["ALLOW_DOWNLOADS"] = True
    window = webview.create_window(
        title, url + "/" + args.page,
        width=1440, height=900, min_size=(800, 560), maximized=True,
        background_color="#080d18", text_select=True, zoomable=True,
    )
    def set_window_icon():
        from System.Drawing import Icon

        window.native.Icon = Icon(str(ROOT / "channel_ui" / "flowform.ico"))

    window.events.before_show += set_window_icon
    # Use a separate persistent profile for project autosave and workspace preferences.
    menu = None
    if release_config.is_file():
        from webview.menu import MenuAction
        from update_client import check_for_update

        def message(text, flags):
            return ctypes.windll.user32.MessageBoxW(None, text, "FlowForm", flags | 0x10000)

        def update_clicked():
            check_for_update(
                release_config, PROFILE, url,
                lambda text: message(text, 0x40),
                lambda text: message(text, 0x24) == 6,
                window.destroy,
            )

        menu = [MenuAction("업데이트 확인", update_clicked)]
    webview.start(gui="edgechromium", private_mode=False, storage_path=str(PROFILE / "WebView2"), menu=menu)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        PROFILE.mkdir(parents=True, exist_ok=True)
        log = PROFILE / "desktop.log"
        with log.open("a", encoding="utf-8") as output:
            traceback.print_exc(file=output)
        ctypes.windll.user32.MessageBoxW(
            None, f"FlowForm을 시작할 수 없습니다.\n\n{error}\n\n오류 기록: {log}",
            "FlowForm", 0x10,
        )
        sys.exit(1)

