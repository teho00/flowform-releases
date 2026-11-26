"""Loopback CAD, OpenFOAM flow workspace, and plane-channel benchmark."""

import argparse
import hashlib
import csv
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread
from urllib.parse import parse_qs, urlsplit
from zipfile import ZIP_DEFLATED, ZipFile

import cad_model
import cfd_case
import flow_contours
import flow_setup
import mesh_preview


ROOT = Path(__file__).resolve().parent
EXAMPLE = ROOT / "OpenFOAM14_channel"
GRIDS = (20, 40, 80)
COMMANDS = ("blockMesh", "checkMesh", "foamRun", "foamPostProcess", "python3", "sh")
STAGE_MARKERS = {
    "log.blockMesh": "blockMesh",
    "log.checkMesh": "checkMesh",
    "log.foamRun": "foamRun",
    "log.centres": "postprocess",
}
CASE_LOGS = ("log.make_case", "log.Allrun", *STAGE_MARKERS)
SUMMARY_FIELDS = (
    "tap_dp_Pa", "tap_dp_exact_Pa", "tap_dp_error_percent", "tap_a_x_m", "tap_b_x_m",
    "cells", "centre_section_Ux_profile_relative_L2_percent",
)
PROFILE_FIELDS = ("y_over_H", "Ux_CFD_m_s", "Ux_exact_at_centre_m_s")
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/cad": ("cad.html", "text/html; charset=utf-8"),
    "/workspace.css": ("workspace.css", "text/css; charset=utf-8"),
    "/flowform.svg": ("flowform.svg", "image/svg+xml"),
    "/favicon.ico": ("flowform.ico", "image/x-icon"),
    "/cad.css": ("cad.css", "text/css; charset=utf-8"),
    "/cad.js": ("cad.js", "text/javascript; charset=utf-8"),
    "/cad-view.js": ("cad-view.js", "text/javascript; charset=utf-8"),
    "/cad-sketch-tools.js": ("cad-sketch-tools.js", "text/javascript; charset=utf-8"),
    "/flow": ("flow.html", "text/html; charset=utf-8"),
    "/flow.css": ("flow.css", "text/css; charset=utf-8"),
    "/flow.js": ("flow.js", "text/javascript; charset=utf-8"),
    "/contour-view.js": ("contour-view.js", "text/javascript; charset=utf-8"),
}
CAD_EXPORTS = {"/api/cad/export/part.step": "part", "/api/cad/export/domain.step": "domain"}
CAD_REQUEST_LIMIT = 6 * 1024 * 1024
RUN_ID = re.compile(r"[0-9a-f]{12}")
LOG_LIMIT = 64 * 1024
FLOW_LOGS = {
    "prepare": "log.prepare", "mesh": "log.gmsh", "convert": "log.gmshToFoam",
    "checkMesh": "log.checkMesh", "foamRun": "log.foamRun", "postprocess": "log.postprocess",
}
FLOW_DOWNLOADS = {
    "domain.msh": ("case/domain.msh", "application/octet-stream"),
    "case.zip": ("case.zip", "application/zip"),
    "orthogonal-quality.csv": ("case/orthogonal-quality.csv", "text/csv; charset=utf-8"),
    "profile.csv": ("case/analysis/profile.csv", "text/csv; charset=utf-8"),
}
PORTABLE_CASE_README = '''OpenFOAM Foundation v14

source /opt/openfoam14/etc/bashrc
gmshToFoam domain.msh
python3 cfd_case.py wall-type .
checkMesh
foamRun > log.foamRun 2>&1
foamPostProcess -latestTime -func writeCellCentres
python3 cfd_case.py analyse .

Check that checkMesh reports Mesh OK before starting foamRun.
The results are written to analysis/summary.json and analysis/profile.csv.
'''


def environment(demo):
    version = os.environ.get("WM_PROJECT_VERSION") or None
    commands = {name: shutil.which(name) for name in COMMANDS}
    problems = []
    if version != "14":
        problems.append("WSL Ubuntu에서 Foundation v14를 불러오세요. source /opt/openfoam14/etc/bashrc")
    for name, path in commands.items():
        if not path:
            problems.append(f"PATH에서 {name} 명령을 찾을 수 없습니다.")
    return {"version": version, "commands": commands, "ready": not problems, "problems": problems, "demo": demo}


def read_results(case, ny):
    analysis = case / "analysis"
    summary = json.loads((analysis / "summary.json").read_text(encoding="utf-8"))
    values = [summary[key] for key in SUMMARY_FIELDS]
    imbalance = summary["boundary_flux_imbalance_percent"]
    if imbalance is not None:
        values.append(imbalance)
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in values):
        raise ValueError("summary.json에 유효하지 않은 수치가 있습니다.")
    if summary["cells"] != 10 * ny * ny:
        raise ValueError("summary.json의 셀 수가 선택한 격자와 다릅니다.")

    with (analysis / "profile.csv").open(encoding="utf-8", newline="") as source:
        rows = csv.DictReader(source)
        profile = [{key: float(row[key]) for key in PROFILE_FIELDS} for row in rows]
    if len(profile) != ny or any(
        not all(math.isfinite(value) for value in point.values()) or not 0 <= point["y_over_H"] <= 1
        for point in profile
    ):
        raise ValueError("profile.csv의 표본이 선택한 격자와 맞지 않습니다.")
    return summary, sorted(profile, key=lambda point: point["y_over_H"])


class Runs:
    def __init__(self, directory, demo):
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.demo = demo
        self.lock = Lock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="openfoam")
        for run in self.list():
            if run["status"] in ("queued", "running"):
                self.update(run, status="failed", error="서버가 중단되어 실행 상태를 확인할 수 없습니다.")

    def list(self):
        runs = []
        for entry in self.directory.iterdir():
            run = self.get(entry.name)
            if run is not None:
                runs.append(run)
        return sorted(runs, key=lambda run: run["created_at"], reverse=True)

    def get(self, run_id):
        if not RUN_ID.fullmatch(run_id):
            return None
        record = self.directory / run_id / "run.json"
        with self.lock:
            try:
                return json.loads(record.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return None

    def update(self, run, **changes):
        run.update(changes)
        record = self.directory / run["id"] / "run.json"
        temporary = record.with_suffix(".tmp")
        with self.lock:
            temporary.write_text(json.dumps(run, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temporary.replace(record)

    def start(self, ny):
        run_id = uuid.uuid4().hex[:12]
        (self.directory / run_id).mkdir()
        run = {
            "id": run_id, "ny": ny, "created_at": datetime.now(timezone.utc).isoformat(),
            "status": "queued", "stage": "prepare", "demo": self.demo, "error": None,
        }
        self.update(run)
        self.pool.submit(self.execute, run.copy())
        return run

    def log_path(self, run, filename):
        base = self.directory / run["id"]
        return (base / "case" if filename in STAGE_MARKERS else base) / filename

    def detail(self, run):
        run = dict(run, summary=None, profile=None)
        run["logs"] = [name for name in CASE_LOGS if self.log_path(run, name).is_file()]
        if run["status"] == "complete":
            try:
                run["summary"], run["profile"] = read_results(self.directory / run["id"] / "case", run["ny"])
            except (OSError, ValueError, KeyError, TypeError) as error:
                run["result_error"] = f"저장된 결과를 읽을 수 없습니다. {error}"
        return run

    def capture(self, command, directory, log, run=None):
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        with log.open("a", encoding="utf-8", buffering=1) as output:
            with subprocess.Popen(
                command, cwd=directory, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace",
            ) as process:
                for line in process.stdout:
                    output.write(line)
                    if run is not None and line.startswith("Running "):
                        marker = line.strip().partition("; see ")[2]
                        if marker in STAGE_MARKERS:
                            self.update(run, stage=STAGE_MARKERS[marker])
                return process.wait()

    def execute(self, run):
        directory = self.directory / run["id"]
        case = directory / "case"
        self.update(run, status="running")
        try:
            code = self.capture(
                [sys.executable, "-u", str(EXAMPLE / "make_case.py"), str(case), "--ny", str(run["ny"])],
                directory, directory / "log.make_case",
            )
            if code != 0:
                raise RuntimeError(f"케이스 생성기가 종료 코드 {code}를 반환했습니다.")

            if run["demo"]:
                self.update(run, stage="postprocess")
                code = self.capture(
                    [sys.executable, "-u", str(ROOT / "demo_fields.py"), str(case)],
                    case, directory / "log.Allrun",
                )
            else:
                self.update(run, stage="environment")
                setup = environment(demo=False)
                if not setup["ready"]:
                    (directory / "log.Allrun").write_text("\n".join(setup["problems"]) + "\n", encoding="utf-8")
                    raise RuntimeError("OpenFOAM 실행 환경을 확인하세요. " + setup["problems"][0])
                code = self.capture([setup["commands"]["sh"], "./Allrun"], case, directory / "log.Allrun", run)

            if code != 0:
                raise RuntimeError(f"실행 프로세스가 종료 코드 {code}를 반환했습니다.")
            self.update(run, stage="postprocess")
            try:
                read_results(case, run["ny"])
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise RuntimeError(f"결과 파일을 확인할 수 없습니다. {error}") from error
            self.update(run, status="complete")
        except (OSError, RuntimeError) as error:
            self.update(run, status="failed", error=str(error))


class RunStopped(Exception):
    pass


class FlowRuns(Runs):
    def list(self, archived=False):
        return [run for run in super().list() if bool(run.get("archived")) == archived]

    def set_archived(self, run, archived):
        if run["status"] in ("running", "queued"):
            raise ValueError("진행 중인 실행은 완료 또는 중지 후 삭제할 수 있습니다.")
        marker = self.directory / run["id"] / "archived"
        if archived:
            marker.touch()
        else:
            marker.unlink(missing_ok=True)

    def get(self, run_id):
        run = super().get(run_id)
        if run is not None:
            folder = self.directory / run_id
            run["archived"] = (folder / "archived").is_file()
            label = folder / "label.txt"
            if label.is_file():
                run["label"] = label.read_text(encoding="utf-8")
            run["stop_requested"] = (folder / "stop.request").exists()
        return run

    def check_stop(self, run):
        if (self.directory / run["id"] / "stop.request").exists():
            raise RunStopped()

    def request_stop(self, run):
        folder = self.directory / run["id"]
        (folder / "stop.request").touch()
        if run["status"] == "queued":
            # A worker dequeuing concurrently also checks the same marker.
            self.update(run, status="stopped")
        if run["stage"] == "foamRun" and run["status"] == "running":
            (folder / "case/flowformStop").touch()

    def mesh_comparison(self, source):
        keys = ("mode", "fluid", "rho", "mu", "inlet_speed_m_s", "outlet_pressure_pa", "inlet", "outlet")
        def geometry(case):
            step = (case / "domain.step").read_bytes()
            _, marker, entities = step.partition(b"DATA;")
            # OCCT increments its generated product label on every export.
            entities = re.sub(rb"'Open CASCADE STEP translator [0-9.]+ [0-9]+'", b"'OCCT'", entities)
            return hashlib.sha256(entities if marker else step).digest()
        reference = geometry(self.directory / source["id"] / "case")
        rows = []
        for run in self.list():
            if (run["status"] != "complete" or run["mesh_only"] or run.get("result_source") == "sample"
                    or run["setup"]["mode"] != "steady"
                    or run["setup"].get("outlet_mode", "target") != source["setup"].get("outlet_mode", "target")
                    or any(run["setup"].get(key) != source["setup"].get(key) for key in keys)):
                continue
            case = self.directory / run["id"] / "case"
            if not (case / "domain.step").exists() or geometry(case) != reference:
                continue
            mesh = json.loads((case / "mesh.json").read_text())
            summary = json.loads((case / "analysis/summary.json").read_text())
            log = case / "log.checkMesh"
            angle = re.search(r"Mesh non-orthogonality Max:\s*([\d.eE+-]+)", log.read_text(errors="replace")) if log.exists() else None
            quality = (mesh.get("orthogonal_quality") or {}).get("min")
            if quality is None and mesh.get("method") in ("gmsh-tetra", "tetra-hxt"):
                try:
                    quality = flow_contours.tetra_orthogonality(case, mesh["cells"])
                except (OSError, ValueError):
                    pass  # Older archives may not contain cell centres.
            rows.append({"id": run["id"], "size": run["setup"]["mesh_mm"], "cells": mesh["cells"],
                         "max_angle": float(angle[1]) if angle else None, "group":run["setup"].get("refinement_group"),
                         "divisions":mesh.get("divisions"), "imbalance":summary.get("flux_imbalance_percent"),
                         "method": mesh.get("method", "tetra"), "quality": quality,
                         "pressure": summary["pressure_drop_pa"], "converged": summary.get("steady_converged")})
        return sorted(rows, key=lambda row: row["cells"])

    def __init__(self, directory, demo):
        super().__init__(directory, demo)
        self.inlets = {}
        self.inlet_lock = Lock()

    def live_solve(self, run, case, command):
        setup = run["setup"]
        mesh = json.loads((case / "mesh.json").read_text(encoding="utf-8"))
        area = mesh["inlet_area_mm2"]
        rate = setup["inlet_speed_m_s"] * area * 60
        end = setup["end_time_s"]
        segments = min(20, max(1, math.ceil(end / setup["time_step_s"])))
        interval = setup.get("save_interval_s", end / segments)
        if setup.get("step_count") and "save_interval_s" not in setup:
            interval = math.ceil(setup["step_count"] / segments) * setup["time_step_s"]
        scheduled = {float(cfd_case.foam_number(row["time_s"])):row["ml_min"] for row in setup.get("flow_schedule",[])}
        targets = sorted({float(cfd_case.foam_number(min(i*interval,end))) for i in range(1,math.ceil(end/interval)+1)} |
                         {float(cfd_case.foam_number(end))} | {t for t in scheduled if t>0})
        control = case / "system/controlDict"
        template = control.read_text().replace("startFrom startTime;", "startFrom latestTime;")
        if setup.get("step_count"):
            template = template.replace("writeControl adjustableRunTime;", "writeControl timeStep;")
        frames = case / "live"
        frames.mkdir()
        start = case / "0"
        with self.inlet_lock:
            self.inlets[run["id"]] = rate
        try:
            for index, finish in enumerate(targets):
                with self.inlet_lock:
                    at = targets[index-1] if index else 0.0
                    rate = scheduled.get(at, self.inlets[run["id"]])
                    self.inlets[run["id"]] = rate
                    if index == len(targets)-1:
                        del self.inlets[run["id"]]
                self.update(run, stage="foamRun", inlet_open=index < len(targets)-1, applied_ml_min=rate)
                velocity = " ".join(cfd_case.foam_number(-n * rate / (60 * area)) for n in setup["inlet"]["normal"])
                path = start / "U"
                content, count = re.subn(r"(\binlet\s*\{[^{}]*?\bvalue\s+uniform\s*)\([^()]*\)",
                                         lambda m: m[1] + "(" + velocity + ")", path.read_text(), count=1)
                if count != 1:
                    raise ValueError("입구 속도 경계조건을 갱신할 수 없습니다.")
                path.write_text(content)
                target = cfd_case.foam_number(finish)
                # A fresh solver process starts the time-step index at zero.
                writes = str(round((finish - at) / setup["time_step_s"])) if setup.get("step_count") else target
                config = re.sub(r"endTime [^;]+;", f"endTime {target};", template)
                control.write_text(re.sub(r"writeInterval [^;]+;", f"writeInterval {writes};", config))
                self.run_command(run, case, "foamRun", command)
                start = cfd_case.latest_time(case)
                if not math.isclose(float(start.name), float(target), rel_tol=1e-8):
                    raise ValueError("솔버가 요청한 구간 끝에 도달하지 못했습니다.")
                snapshot = frames / start.name
                snapshot.mkdir()
                for field in ("p", "U"):
                    shutil.copyfile(start / field, snapshot / field)
                history = run.setdefault("inlet_history", [])
                history.append({"end_time_s": float(start.name), "ml_min": rate})
                self.update(run, frame=start.name, frame_ml_min=rate)
        finally:
            with self.inlet_lock:
                self.inlets.pop(run["id"], None)
            self.update(run, inlet_open=False)

    def start(self, setup, step):
        run_id = uuid.uuid4().hex[:12]
        directory = self.directory / run_id
        directory.mkdir()
        (directory / "domain.step").write_bytes(step)
        return self.queue_run(run_id, setup)

    def can_reuse(self, run):
        return run["status"] in ("complete", "failed") and self.download(run, "domain.msh") is not None

    def start_from_mesh(self, source, setup):
        run_id = uuid.uuid4().hex[:12]
        (self.directory / run_id).mkdir()
        return self.queue_run(run_id, setup, source_mesh_id=source["id"])

    def queue_run(self, run_id, setup, **fields):
        run = {
            "id": run_id, "setup": setup, "mesh_only": setup["mesh_only"],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": "queued", "stage": "prepare", "error": None,
            **fields,
        }
        self.update(run)
        self.pool.submit(self.execute, run.copy())
        return run

    def log_path(self, run, filename):
        base = self.directory / run["id"]
        return (base if filename == FLOW_LOGS["prepare"] else base / "case") / filename

    def download(self, run, action):
        if action not in FLOW_DOWNLOADS:
            return None
        directory = self.directory / run["id"]
        if action == "domain.msh" and not (directory / "case" / "mesh.json").is_file():
            return None
        if action == "profile.csv" and (run["status"] != "complete" or run["mesh_only"]):
            return None
        relative_path, content_type = FLOW_DOWNLOADS[action]
        path = directory / relative_path
        return (path, content_type) if path.is_file() else None

    def detail(self, run):
        detail = dict(run, summary=None, profile=None, mesh=None, mesh_reusable=self.can_reuse(run))
        detail["logs"] = [name for name in FLOW_LOGS.values() if self.log_path(run, name).is_file()]
        detail["files"] = {
            key: self.download(run, action) is not None
            for key, action in (("mesh", "domain.msh"), ("case", "case.zip"), ("csv", "profile.csv"))
        }
        if self.download(run, "orthogonal-quality.csv") is not None:
            detail["files"]["quality"] = True
        case = self.directory / run["id"] / "case"
        try:
            if detail["files"]["mesh"]:
                detail["mesh"] = json.loads((case / "mesh.json").read_text(encoding="utf-8"))
            if run["status"] == "complete" and not run["mesh_only"]:
                detail["summary"], detail["profile"] = cfd_case.read_results(case)
                detail["contours"] = (case / "constant" / "polyMesh" / "faces").is_file()
        except (OSError, ValueError, KeyError, TypeError) as error:
            detail["result_error"] = f"저장된 결과를 읽을 수 없습니다. {error}"
        return detail

    def prepare_case(self, run, case):
        setup = run["setup"]
        source_id = run.get("source_mesh_id")
        log = self.log_path(run, FLOW_LOGS["prepare"])
        message = f"실행 {source_id}의 격자를 재사용합니다." if source_id else "CAD 유체 체적과 해석 조건을 저장합니다."
        log.write_text(message + "\n", encoding="utf-8")
        cfd_case.prepare(case, setup)
        if source_id:
            source = self.directory / source_id / "case"
            for name in ("domain.step", "domain.msh", "mesh.json"):
                shutil.copyfile(source / name, case / name)
            quality = source / "orthogonal-quality.csv"
            if quality.is_file():
                shutil.copyfile(quality, case / quality.name)
        else:
            shutil.move(case.parent / "domain.step", case / "domain.step")
            self.run_command(run, case, "mesh", [sys.executable, "-u", str(ROOT / "cfd_mesh.py"), str(case)])
        json.loads((case / "mesh.json").read_text(encoding="utf-8"))
        self.archive_case(case)

    def solve_case(self, run, case, setup):
        env = flow_setup.environment(self.demo)
        if not env["solver_ready"]:
            raise RuntimeError(" ".join(env["solver_problems"]))
        if setup.get("compute_backend") == "gpu-pressure" and not env.get("gpu_pressure_ready"):
            raise RuntimeError("GPU 압력 솔버를 사용할 수 없습니다. 실행 환경에서 CUDA 압력 가속을 확인하세요.")
        command = flow_setup.solver_command
        self.run_command(run, case, "convert", command(env, case, "gmshToFoam", "domain.msh"))
        cfd_case.set_wall_type(case)
        check_log = self.run_command(run, case, "checkMesh", command(env, case, "checkMesh"))
        if not any(line.strip() == "Mesh OK." for line in check_log.read_text(encoding="utf-8").splitlines()):
            raise RuntimeError("checkMesh가 격자를 통과시키지 못했습니다. log.checkMesh를 확인하세요.")
        if setup.get("live"):
            self.live_solve(run, case, command(env, case, "foamRun"))
        else:
            self.run_command(run, case, "foamRun", command(env, case, "foamRun"))
        self.run_command(
            run, case, "postprocess", command(env, case, "foamPostProcess", "-latestTime", "-func", "writeCellCentres"),
        )
        cfd_case.analyse(case, setup)
        summary, _ = cfd_case.read_results(case)
        mesh = json.loads((case / "mesh.json").read_text(encoding="utf-8"))
        if summary["cells"] != mesh["cells"]:
            raise ValueError("OpenFOAM 계산 결과의 셀 수가 저장 격자의 셀 수와 다릅니다.")
        flow_contours.load(case, summary["time_directory"], setup["rho"], summary["cells"])

    def run_command(self, run, case, stage, command):
        self.check_stop(run)
        self.update(run, stage=stage)
        log = self.log_path(run, FLOW_LOGS[stage])
        code = self.capture(command, case, log)
        self.check_stop(run)
        if code:
            raise RuntimeError(f"{log.name} 단계가 종료 코드 {code}를 반환했습니다.")
        return log

    def archive_case(self, case):
        temporary = case.parent / "case.zip.tmp"
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED) as archive:
            for name in ("domain.step", "domain.msh", "setup.json"):
                archive.write(case / name, name)
            quality = case / "orthogonal-quality.csv"
            if quality.is_file():
                archive.write(quality, quality.name)
            for folder in ("0", "constant", "system"):
                for path in (case / folder).glob("*"):
                    if path.is_file():
                        archive.write(path, path.relative_to(case).as_posix())
            archive.write(ROOT / "cfd_case.py", "cfd_case.py")
            archive.writestr("README.txt", PORTABLE_CASE_README)
        temporary.replace(case.parent / "case.zip")

    def execute(self, run):
        directory = self.directory / run["id"]
        case = directory / "case"
        setup = run["setup"]
        self.update(run, status="running")
        try:
            self.check_stop(run)
            self.prepare_case(run, case)
            if not run["mesh_only"]:
                self.solve_case(run, case, setup)
            self.check_stop(run)
            self.update(run, status="complete")
        except RunStopped:
            self.update(run,status="stopped",inlet_open=False)
        except (OSError, RuntimeError, ValueError, KeyError, TypeError) as error:
            failure_log = self.log_path(run, FLOW_LOGS[run["stage"]])
            try:
                with failure_log.open("a", encoding="utf-8") as output:
                    output.write(f"\n{error}\n")
            except OSError:
                pass
            self.update(run, status="failed", error=str(error))


def configure_runs(server, directory, demo, *, flow_demo=None):
    server.runs = Runs(directory, demo)
    server.flow_runs = FlowRuns(directory / "flow", demo if flow_demo is None else flow_demo)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def send_data(self, data, content_type, status=200, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        try:
            self.end_headers()
            self.wfile.write(data)
        except ConnectionError:
            pass

    def send_json(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_data(data, "application/json; charset=utf-8", status)

    def local_request(self):
        port = self.server.server_port
        hosts = {"127.0.0.1", "localhost", f"127.0.0.1:{port}", f"localhost:{port}"}
        if self.headers.get("Host", "").lower() not in hosts:
            self.send_json({"error": "로컬 주소로 접속하세요."}, 403)
            return False
        return True

    def do_GET(self):
        if not self.local_request():
            return
        url = urlsplit(self.path)
        path = url.path
        store = self.server.runs
        try:
            if path in STATIC:
                name, content_type = STATIC[path]
                self.send_data((ROOT / "channel_ui" / name).read_bytes(), content_type)
                return
            if path == "/api/environment":
                self.send_json(environment(store.demo))
                return
            if path == "/api/flow/environment":
                self.send_json(flow_setup.environment(self.server.flow_runs.demo))
                return
            if path == "/api/flow/runs" or path.startswith("/api/flow/runs/"):
                self.send_flow_run(path, url.query)
                return
            if path == "/api/cad/status":
                self.send_json(cad_model.status())
                return
            if path == "/api/runs":
                self.send_json({"runs": store.list()})
                return

            match = re.fullmatch(r"/api/runs/([^/]+)(?:/(.+))?", path)
            run = store.get(match[1]) if match else None
            if run is not None:
                action = match[2]
                if action is None:
                    self.send_json(store.detail(run))
                    return
                if action == "profile.csv" and run["status"] == "complete":
                    source = store.directory / run["id"] / "case" / "analysis" / "profile.csv"
                    sample = "test-" if run["demo"] else ""
                    filename = f"{sample}profile-ny{run['ny']}-{run['id']}.csv"
                    self.send_data(source.read_bytes(), "text/csv; charset=utf-8", filename=filename)
                    return
                if action in {f"logs/{name}" for name in CASE_LOGS}:
                    self.send_log(store.log_path(run, action.split("/")[1]))
                    return
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as error:
            self.send_json({"error": f"파일을 읽을 수 없습니다. {error}"}, 500)
            return
        self.send_json({"error": "요청한 실행이나 파일을 찾을 수 없습니다."}, 404)

    def send_flow_run(self, path, query):
        store = self.server.flow_runs
        if path == "/api/flow/runs":
            self.send_json({"runs": store.list(archived=parse_qs(query).get("archived") == ["1"])})
            return
        match = re.fullmatch(r"/api/flow/runs/([^/]+)(?:/(.+))?", path)
        run = store.get(match[1]) if match else None
        if run is not None:
            action = match[2]
            if action is None:
                self.send_json(store.detail(run))
                return
            if action == "mid-profile" and run["status"]=="complete" and run["setup"]["mode"]=="steady" and not run["mesh_only"]:
                try:
                    case=store.directory/run["id"]/"case"
                    summary=json.loads((case/"analysis/summary.json").read_text())
                    self.send_json(flow_contours.middle_profile(case,summary["time_directory"],run["setup"]["rho"],summary["cells"]))
                except (OSError,ValueError) as error:
                    self.send_json({"error":str(error)},422)
                return
            if action == "residuals":
                log = store.log_path(run, FLOW_LOGS["foamRun"])
                data = cfd_case.residual_progress(log)
                if parse_qs(query).get("progress") == ["1"]:
                    self.send_json(data)
                else:
                    self.send_json(data["residuals"])
                return
            if action == "quality-map" and store.download(run,"domain.msh"):
                try:
                    import mesh_quality
                    self.send_json(mesh_quality.inspect(store.directory / run["id"] / "case"))
                except (ValueError,OSError, ImportError) as error:
                    self.send_json({"error":str(error)},422)
                return
            if action == "mesh-preview":
                self.send_mesh_preview(store, run, query)
                return
            if action == "contour":
                self.send_flow_contour(store, run, query)
                return
            if action in ("timeline", "comparison") and run["status"] == "complete" and not run["mesh_only"]:
                case = store.directory / run["id"] / "case"
                try:
                    if action == "comparison":
                        data = store.mesh_comparison(run)
                    else:
                        mesh = json.loads((case / "mesh.json").read_text())
                        data = flow_contours.timeline(case, run["setup"]["rho"], mesh["cells"], mesh["inlet_area_mm2"])
                    self.send_json(data)
                except (OSError, KeyError, ValueError) as error:
                    self.send_json({"error": str(error)}, 422)
                return
            download = store.download(run, action)
            if download is not None:
                source, content_type = download
                prefix = "sample-" if run.get("result_source") == "sample" and action == "profile.csv" else ""
                self.send_data(source.read_bytes(), content_type, filename=f"{prefix}flow-{run['id']}-{action}")
                return
            if action in {f"logs/{name}" for name in FLOW_LOGS.values()}:
                self.send_log(store.log_path(run, action.split("/")[1]))
                return
        self.send_json({"error": "요청한 유동해석 실행이나 파일을 찾을 수 없습니다."}, 404)

    def send_mesh_preview(self, store, run, query):
        mesh_file = store.download(run, "domain.msh")
        if mesh_file is None:
            self.send_json({"error": "이 실행에 표시할 격자가 없습니다."}, 404)
            return
        try:
            params = parse_qs(query, keep_blank_values=True, max_num_fields=2)
            axis = params.get("axis", [None])[0]
            fraction = float(params.get("fraction", ["0.5"])[0])
            if (axis not in (None, "x", "y", "z") or not 0 <= fraction <= 1
                    or set(params) - {"axis", "fraction"} or any(len(values) != 1 for values in params.values())):
                raise ValueError
        except ValueError:
            self.send_json({"error": "단면 축과 위치를 확인하세요."}, 400)
            return
        try:
            result = mesh_preview.preview(mesh_file[0], axis, fraction)
        except ValueError as error:
            self.send_json({"error": str(error)}, 422)
            return
        self.send_json(result)

    def send_flow_contour(self, store, run, query):
        live = run.get("frame") and run["status"] == "running"
        if (run["status"] != "complete" and not live) or run["mesh_only"]:
            self.send_json({"error": "완료된 유동해석 결과를 선택하세요."}, 404)
            return
        try:
            params = parse_qs(query, keep_blank_values=True, max_num_fields=4)
            requested_time = params.get("time", [None])[0]
            field = params.get("field", ["pressure"])[0]
            axis = params.get("axis", [None])[0]
            fraction = float(params.get("fraction", ["0.5"])[0])
            if (field not in flow_contours.FIELDS or axis not in (None, "x", "y", "z") or not 0 <= fraction <= 1
                    or set(params) - {"field", "axis", "fraction", "time"} or any(len(values) != 1 for values in params.values())):
                raise ValueError
        except ValueError:
            self.send_json({"error": "표시 물리량, 단면 축과 위치를 확인하세요."}, 400)
            return
        case = store.directory / run["id"] / "case"
        try:
            if live:
                instant = run["frame"]
                cells = json.loads((case / "mesh.json").read_text())["cells"]
            else:
                summary, _ = cfd_case.read_results(case)
                instant, cells = summary["time_directory"], summary["cells"]
            rate = run.get("frame_ml_min")
            if requested_time is not None:
                if run["status"] != "complete":
                    raise ValueError("완료된 실행의 저장 시점을 선택하세요.")
                area = json.loads((case / "mesh.json").read_text())["inlet_area_mm2"]
                timeline = flow_contours.timeline(case, run["setup"]["rho"], cells, area)
                rates = {frame["time"]: frame["ml_min"] for frame in timeline["frames"]}
                if requested_time not in rates:
                    raise ValueError("저장된 해석 시점이 없습니다.")
                instant, rate = requested_time, rates[requested_time]
            mesh = flow_contours.load(case, instant, run["setup"]["rho"], cells, bool(live or requested_time))
            result = flow_contours.preview(mesh, field, axis, fraction)
            if requested_time is not None:
                result["minimum"], result["maximum"] = timeline["limits"][field]
        except (OSError, ValueError, KeyError, TypeError) as error:
            self.send_json({"error": f"컨투어 결과를 읽을 수 없습니다. {error}"}, 422)
            return
        result["time_directory"] = instant
        result["frame_ml_min"] = rate
        result["source"] = run.get("result_source", "openfoam")
        self.send_json(result)

    def send_log(self, log):
        with log.open("rb") as source:
            size = source.seek(0, os.SEEK_END)
            source.seek(max(0, size - LOG_LIMIT))
            self.send_json({
                "text": source.read(LOG_LIMIT).decode("utf-8", errors="replace"),
                "truncated": size > LOG_LIMIT,
            })

    def do_POST(self):
        if not self.local_request():
            return
        if not getattr(self.server, "update_token", None):
            self.handle_post()
            return
        with self.server.update_lock:
            if self.server.updating:
                self.send_json({"error": "FlowForm 업데이트가 진행 중입니다."}, 409)
            elif self.path == "/api/desktop/prepare-update":
                self.prepare_update()
            else:
                self.handle_post()

    def prepare_update(self):
        supplied = self.headers.get("X-FlowForm-Update-Token", "")
        if not secrets.compare_digest(supplied.encode("utf-8"), self.server.update_token.encode("ascii")):
            self.send_json({"error": "업데이트 요청을 확인할 수 없습니다."}, 403)
            return
        if any(run["status"] in ("running", "queued") for store in (self.server.runs, self.server.flow_runs)
               for run in store.list()):
            self.send_json({"error": "진행 중이거나 대기 중인 해석이 있습니다."}, 409)
            return
        self.server.updating = True
        self.send_json({"ok": True})
        Thread(target=self.server.shutdown, daemon=True).start()

    def handle_post(self):
        if self.path in ("/api/cad/model", "/api/flow/domain", "/api/flow/runs") or self.path in CAD_EXPORTS:
            self.cad_request()
            return
        solve = re.fullmatch(r"/api/flow/runs/([0-9a-f]{12})/solve", self.path)
        inlet = re.fullmatch(r"/api/flow/runs/([0-9a-f]{12})/inlet", self.path)
        control = re.fullmatch(r"/api/flow/runs/([0-9a-f]{12})/(label|stop|archive|restore)", self.path)
        if control:
            store = self.server.flow_runs
            run = store.get(control[1])
            if run is None:
                self.send_json({"error":"실행을 찾을 수 없습니다."},404)
                return
            try:
                size = int(self.headers.get("Content-Length","0"))
                if self.headers.get_content_type() != "application/json" or not 0<size<=1024: raise ValueError
                payload=json.loads(self.rfile.read(size))
                if not isinstance(payload,dict): raise ValueError
                folder=store.directory / run["id"]
                if control[2]=="label":
                    label=payload.get("label")
                    if not isinstance(label,str) or len(label)>80: raise ValueError
                    tmp=folder/(uuid.uuid4().hex+".tmp")
                    tmp.write_text(label.strip(),encoding="utf-8")
                    tmp.replace(folder/"label.txt")
                elif control[2] in ("archive", "restore"):
                    store.set_archived(run, control[2] == "archive")
                else:
                    if run["status"] not in ("running","queued"):
                        self.send_json({"error":"이미 종료된 실행입니다."},409)
                        return
                    store.request_stop(run)
                self.send_json({"ok":True})
            except (ValueError,OSError):
                self.send_json({"error":"요청을 저장하지 못했습니다."},400)
            return
        if inlet:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.headers.get_content_type() != "application/json" or not 0 < length <= 1024:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
                rate = flow_setup.number(body, "ml_min", "입구 유량", minimum=0)
            except (ValueError, RecursionError):
                self.send_json({"error": "0 이상의 유량(mL/min)을 입력하세요."}, 400)
                return
            store = self.server.flow_runs
            with store.inlet_lock:
                accepted = inlet[1] in store.inlets
                if accepted:
                    store.inlets[inlet[1]] = rate
            self.send_json({"ml_min": rate} if accepted else {"error": "유량 변경 가능 구간이 종료되었습니다."}, 202 if accepted else 409)
            return
        if solve:
            self.solve_saved_flow(solve[1])
            return
        if self.path != "/api/runs":
            self.send_json({"error": "요청한 경로를 찾을 수 없습니다."}, 404)
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json({"error": "JSON 요청이 필요합니다."}, 415)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024:
                raise ValueError
            body = json.loads(self.rfile.read(size))
            ny = body.get("ny") if isinstance(body, dict) else None
            if type(ny) is not int or ny not in GRIDS:
                raise ValueError
        except ValueError:
            self.send_json({"error": "ny는 20, 40, 80 중 하나여야 합니다."}, 400)
            return
        try:
            run = self.server.runs.start(ny)
        except OSError as error:
            self.send_json({"error": f"실행 폴더를 만들 수 없습니다. {error}"}, 500)
            return
        self.send_json(run, 202)

    def solve_saved_flow(self, source_id):
        store = self.server.flow_runs
        source = store.get(source_id)
        if source is None:
            self.send_json({"error": "선택한 격자의 실행 기록을 찾지 못했습니다."}, 404)
            return
        if not store.can_reuse(source):
            self.send_json({"error": "격자 생성이 완료된 실행을 선택하세요."}, 409)
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json({"error": "해석 조건을 JSON으로 보내세요."}, 415)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 4096:
                raise ValueError
            changes = json.loads(self.rfile.read(size))
        except (ValueError, RecursionError):
            self.send_json({"error": "해석 조건을 읽을 수 없습니다."}, 400)
            return
        try:
            setup = flow_setup.apply_conditions(source["setup"], changes)
        except ValueError as error:
            self.send_json({"error": str(error)}, 400)
            return
        env = flow_setup.environment(store.demo)
        if not env["solver_ready"]:
            self.send_json({"error": " ".join(env["solver_problems"])}, 503)
            return
        try:
            if changes.get("refine") is True:
                if setup["mode"] != "steady":
                    self.send_json({"error":"세분화 비교는 정상 해석을 선택하세요."}, 400)
                    return
                case = store.directory / source["id"] / "case"
                method = changes.get("mesh_method") or json.loads((case/"mesh.json").read_text())["method"]
                if method not in ("hex-sweep", "hex-dominant", "gmsh-tetra", "tetra-hxt"):
                    self.send_json({"error":"지원하지 않는 격자 방식입니다."}, 400)
                    return
                step = (case / "domain.step").read_bytes()
                group = uuid.uuid4().hex[:12]
                runs = []
                for factor in (1.5, 1, 2/3):
                    config = {**setup, "mesh_mm": setup["mesh_mm"]*factor, "mesh_method":method, "refinement_group":group}
                    for key in ("width_cells","height_cells"):
                        if key in config: config[key]=max(2,math.ceil(config[key]/factor))
                    runs.append(store.start(config, step)["id"])
                self.send_json({"ids":runs}, 202)
                return
            run = store.start_from_mesh(source, setup)
        except OSError as error:
            self.send_json({"error": f"실행 폴더를 만들 수 없습니다. {error}"}, 500)
            return
        self.send_json(run, 202)

    def cad_request(self):
        if self.headers.get_content_type() != "application/json":
            self.send_json({"error": "CAD 프로젝트를 JSON으로 보내야 합니다."}, 415)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0:
                raise ValueError
        except ValueError:
            self.send_json({"error": "CAD 프로젝트 데이터가 비었습니다."}, 400)
            return
        if size > CAD_REQUEST_LIMIT + (4096 if self.path == "/api/flow/runs" else 0):
            self.send_json({"error": "CAD 프로젝트가 너무 큽니다. STEP 파일은 4 MiB까지 불러올 수 있습니다."}, 413)
            return
        try:
            document = json.loads(self.rfile.read(size))
        except (ValueError, RecursionError):
            self.send_json({"error": "CAD 프로젝트 JSON을 읽을 수 없습니다."}, 400)
            return

        state = cad_model.status()
        if not state["ready"]:
            self.send_json({"error": state["message"]}, 503)
            return
        try:
            if self.path == "/api/cad/model":
                result = cad_model.model(document)
            elif self.path == "/api/flow/domain":
                result = cad_model.flow_domain(document)
            elif self.path == "/api/flow/runs":
                setup, refs = flow_setup.parse(document)
                store = self.server.flow_runs
                env = flow_setup.environment(store.demo)
                if not env["mesh_ready"] or (not setup["mesh_only"] and not env["ready"]):
                    issues = env["mesh_problems"] + ([] if setup["mesh_only"] else env["problems"])
                    self.send_json({"error": " ".join(issues)}, 503)
                    return
                step, (setup["inlet"], setup["outlet"]) = cad_model.flow_domain(document["document"], refs)
                setup["cad_revision"] = cad_model.revision(document["document"])
                setup["project_name"] = str(document["document"].get("projectName") or "CAD 프로젝트")[:80]
                result = store.start(setup, step)
            else:
                target = CAD_EXPORTS[self.path]
                result = cad_model.export_step(document, target)
        except cad_model.CadFeatureReferenceError as error:
            self.send_json({"error": str(error), "operationIndex": error.operation_index}, 400)
            return
        except ValueError as error:
            self.send_json({"error": str(error)}, 400)
            return
        except (OSError, RuntimeError):
            message = ("유동해석 파일을 저장하지 못했습니다." if self.path == "/api/flow/runs"
                       else "CAD 커널이 형상을 처리하는 중 오류가 발생했습니다.")
            self.send_json({"error": message}, 500)
            return

        if self.path in ("/api/cad/model", "/api/flow/domain"):
            self.send_json(result)
        elif self.path == "/api/flow/runs":
            self.send_json(result, 202)
        else:
            self.send_data(result, "model/step", filename=f"{target}.step")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000, help="loopback port (default: 8000)")
    parser.add_argument("--runs-dir", type=Path, default=ROOT / "runs", help="run archive directory")
    parser.add_argument("--demo", action="store_true", help="use labeled synthetic data without OpenFOAM")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
        with server:
            configure_runs(server, args.runs_dir, args.demo)
            if os.environ.get("FLOWFORM_INSTALLED") == "1" and os.environ.get("FLOWFORM_PROFILE_DIR"):
                profile = Path(os.environ["FLOWFORM_PROFILE_DIR"])
                profile.mkdir(parents=True, exist_ok=True)
                server.update_token = secrets.token_urlsafe(32)
                server.update_lock = Lock()
                server.updating = False
                token_file = profile / "update-service.token"
                temporary = token_file.with_suffix(".tmp")
                temporary.write_text(server.update_token, encoding="ascii")
                temporary.replace(token_file)
            print(f"http://127.0.0.1:{server.server_port}/", flush=True)
            try:
                server.serve_forever()
            finally:
                server.runs.pool.shutdown(wait=False, cancel_futures=True)
                server.flow_runs.pool.shutdown(wait=False, cancel_futures=True)
    except KeyboardInterrupt:
        return
    except OSError as error:
        parser.exit(1, f"서버를 시작할 수 없습니다. {error}\n")


if __name__ == "__main__":
    main()
