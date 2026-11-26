"""Verify a FlowForm release before launching its installer."""
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
from threading import Lock
from urllib.parse import urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import HTTPSHandler, HTTPRedirectHandler, ProxyHandler, Request, build_opener

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

MAX_MANIFEST = 65536
MAX_INSTALLER = 1024**3
UPDATE_LOCK = Lock()


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:0|[1-9][0-9]{0,3})(?:\.(?:0|[1-9][0-9]{0,3})){2}", value):
        raise ValueError("버전 형식이 올바르지 않습니다.")
    return tuple(map(int, value.split(".")))


def https_url(url):
    if not isinstance(url, str):
        raise ValueError("HTTPS 업데이트 주소를 확인하세요.")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("HTTPS 업데이트 주소를 확인하세요.")
    return url


class SecureRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return super().redirect_request(request, fp, code, message, headers, https_url(new_url))


def verify_manifest(raw, public_key):
    envelope = json.loads(raw)
    payload = base64.b64decode(envelope["payload"], validate=True)
    signature = base64.b64decode(envelope["signature"], validate=True)
    key = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key, validate=True))
    key.verify(signature, payload)
    data = json.loads(payload)
    if data["product"] != "FlowForm":
        raise ValueError("FlowForm 업데이트 정보가 아닙니다.")
    version(data["version"])
    https_url(data["installer_url"])
    if type(data["size"]) is not int or not 0 < data["size"] <= MAX_INSTALLER:
        raise ValueError("설치 파일 크기가 허용 범위를 벗어났습니다.")
    if not re.fullmatch(r"[0-9a-f]{64}", data["sha256"]):
        raise ValueError("설치 파일 SHA-256 값이 올바르지 않습니다.")
    return data


def fetch_release(config):
    opener = build_opener(HTTPSHandler(), SecureRedirect())
    with opener.open(https_url(config["manifest_url"]), timeout=15) as response:
        manifest = response.read(MAX_MANIFEST + 1)
    if len(manifest) > MAX_MANIFEST:
        raise ValueError("업데이트 정보가 너무 큽니다.")
    return verify_manifest(manifest, config["public_key"]), opener


def download_installer(opener, release, destination):
    checksum = hashlib.sha256()
    total = 0
    with opener.open(https_url(release["installer_url"]), timeout=30) as response, destination.open("xb") as file:
        while data := response.read(256 * 1024):
            total += len(data)
            if total > release["size"]:
                raise ValueError("설치 파일 크기가 일치하지 않습니다.")
            checksum.update(data)
            file.write(data)
    if total != release["size"] or checksum.hexdigest() != release["sha256"]:
        raise ValueError("설치 파일 무결성 확인에 실패했습니다.")


def check_idle(local_url):
    opener = build_opener(ProxyHandler({}))
    for path in ("/api/flow/runs", "/api/runs"):
        with opener.open(local_url + path, timeout=5) as response:
            data = json.load(response)
        if any(run["status"] in ("queued", "running") for run in data["runs"]):
            raise RuntimeError("진행 중이거나 대기 중인 해석이 있습니다. 해석을 마친 뒤 다시 시도하세요.")


def prepare_installation(local_url, profile):
    opener = build_opener(ProxyHandler({}))
    token = (profile / "update-service.token").read_text(encoding="ascii").strip()
    request = Request(local_url + "/api/desktop/prepare-update", method="POST",
                      headers={"X-FlowForm-Update-Token": token})
    try:
        with opener.open(request, timeout=5) as response:
            if json.load(response).get("ok") is not True:
                raise RuntimeError("실행 중인 FlowForm을 업데이트할 수 없습니다.")
    except HTTPError as error:
        raise RuntimeError(json.load(error).get("error", str(error))) from error

    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        try:
            with opener.open(local_url + "/flow", timeout=1):
                pass
        except (URLError, OSError):
            return
        time.sleep(0.2)
    raise RuntimeError("FlowForm 서비스 종료를 확인할 수 없습니다.")


def check_for_update(config_path, profile, local_url, notify, confirm, close_window):
    if not UPDATE_LOCK.acquire(blocking=False):
        return
    try:
        config = json.loads(config_path.read_text(encoding="utf-8-sig"))
        registered_channel = profile / "update-channel.json"
        if registered_channel.is_file():
            channel = json.loads(registered_channel.read_text(encoding="utf-8-sig"))
            for field in ("manifest_url", "public_key"):
                config[field] = channel[field]
        if not config.get("manifest_url") or not config.get("public_key"):
            notify("업데이트 서버가 아직 설정되지 않았습니다.")
            return
        release, opener = fetch_release(config)
        if version(release["version"]) <= version(config["current_version"]):
            notify(f'FlowForm {config["current_version"]}이 최신 버전입니다.')
            return
        check_idle(local_url)
        if not confirm(f'FlowForm {release["version"]}을 내려받아 설치하시겠습니까?'):
            return

        directory = profile / "updates"
        directory.mkdir(parents=True, exist_ok=True)
        folder = Path(tempfile.mkdtemp(prefix="flowform-", dir=directory))
        target = folder / "FlowForm-Setup.exe"
        try:
            download_installer(opener, release, target)
            prepare_installation(local_url, profile)
            subprocess.Popen(
                [str(target), "/SILENT", "/NORESTART", "/CLOSEAPPLICATIONS", "/FLOWFORMUPDATE"],
                cwd=folder,
            )
        except Exception:
            target.unlink(missing_ok=True)
            folder.rmdir()
            raise
        close_window()
    except Exception as error:
        from cryptography.exceptions import InvalidSignature
        message = "업데이트 서명 검증에 실패했습니다." if isinstance(error, InvalidSignature) else str(error)
        notify("업데이트할 수 없습니다.\n" + message)
    finally:
        UPDATE_LOCK.release()

