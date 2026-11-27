"""Validate local CAD flow inputs and find available mesh and solver tools."""

import math
import os
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path


COMMANDS = ("gmshToFoam", "checkMesh", "foamRun", "foamPostProcess")
HEX_MESH_METHODS = ("hex-sweep", "hex-dominant")
MESH_METHODS = (*HEX_MESH_METHODS, "gmsh-tetra", "tetra-hxt")
DEFAULT_MESH_METHOD = "hex-dominant"
FLUIDS = ("air", "water", "hydrogen", "custom")
GPU_BIN_DIR = "/opt/openfoam14/platforms/linux64GccDPInt32Opt/bin"
FOAM_BASHRC = "/opt/openfoam14/etc/bashrc"
_wsl_environment = None
LOAD_WSL_FOAM = f'. {FOAM_BASHRC} >/dev/null && [ "$WM_PROJECT_VERSION" = 14 ]'
# OpenFOAM validates both cwd and -case. Keep both paths ASCII even when
# the Windows project lives under a user-chosen name containing spaces.
WSL_RUN = LOAD_WSL_FOAM + r'''
 || exit 1
case_dir=$(wslpath -a "$1") || exit 1
shift
work=$(mktemp -d /tmp/openfoam-case.XXXXXXXX) || exit 1
trap 'rm -f -- "$work/case" "$work/domain.msh"; rmdir -- "$work"' EXIT
cd -- "$work" || exit 1
ln -s -- "$case_dir" case || exit 1
ln -s -- case/domain.msh domain.msh || exit 1
"$@" -case "$work/case"
'''.lstrip()


@lru_cache(maxsize=1)
def gmsh_available():
    try:
        return subprocess.run(
            [sys.executable, "-c", "import gmsh"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=8, check=False,
        ).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def wsl_distribution_args():
    distribution = os.environ.get("FLOWFORM_WSL_DISTRO")
    return ["--distribution", distribution] if distribution else []


def wsl_solver():
    """Discover the WSL solver once it has responded successfully."""
    global _wsl_environment
    if _wsl_environment is not None:
        return _wsl_environment
    wsl = shutil.which("wsl.exe")
    if wsl is None:
        return None
    # The Windows GPU installer records a tested local installation. This also
    # avoids blocking the setup screen on repeated WSL startup probes.
    installed_profile = os.environ.get("FLOWFORM_PROFILE_DIR")
    local_app_data = os.environ.get("LOCALAPPDATA")
    profile = Path(installed_profile) if installed_profile else (
        Path(local_app_data) / "FlowForm" if local_app_data else None
    )
    if profile is not None:
        gpu_ready = (profile / "openfoam14-gpu.ready").is_file()
        cpu_ready = installed_profile and (profile / "openfoam14-cpu.ready").is_file()
        if gpu_ready or cpu_ready:
            _wsl_environment = ({name: f"{GPU_BIN_DIR}/{name}" for name in COMMANDS}, gpu_ready)
            return _wsl_environment
    options = {
        "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE, "stderr": subprocess.DEVNULL,
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0), "timeout": 10, "check": False,
    }
    try:
        distributions = subprocess.run([wsl, "--list", "--quiet"], **options)
        if distributions.returncode or not distributions.stdout.strip(b"\x00\r\n\t "):
            return None
        probe = LOAD_WSL_FOAM + (
            ' && for command in "$@"; do command -v "$command" || exit 1; done'
            ' && if [[ -r "$FOAM_USER_LIBBIN/libflowformGpuPressure.so" && -c /dev/dxg ]];'
            ' then echo gpu-pressure-ready; fi'
        )
        result = subprocess.run([wsl, *wsl_distribution_args(), "--cd", "/", "--exec", "bash", "-c", probe, "openfoam", *COMMANDS], **options)
    except (OSError, subprocess.TimeoutExpired):
        return None
    lines = result.stdout.decode("utf-8", errors="replace").splitlines()
    gpu_ready = lines[-1:] == ["gpu-pressure-ready"]
    paths = lines[:-1] if gpu_ready else lines
    if result.returncode or len(paths) != len(COMMANDS) or not all(path.startswith("/") for path in paths):
        return None
    _wsl_environment = (dict(zip(COMMANDS, paths)), gpu_ready)
    return _wsl_environment


def environment(demo):
    version = os.environ.get("WM_PROJECT_VERSION") or None
    commands = {name: shutil.which(name) for name in COMMANDS}
    mesh_problems = [] if gmsh_available() else [
        "Gmsh를 불러올 수 없습니다. README의 유동해석 설치 방법을 확인하세요."
    ]
    solver_problems = []
    if demo:
        solver_problems.append("이 서버는 시험 모드입니다. 실제 해석은 --demo 없이 시작하세요.")
    if version != "14":
        solver_problems.append(f"OpenFOAM Foundation v14를 불러오세요. source {FOAM_BASHRC}")
    solver_problems.extend(f"PATH에서 {name} 명령을 찾을 수 없습니다." for name, path in commands.items() if not path)
    gpu_ready = False
    backend = "native" if not solver_problems else None
    if backend is None and os.name == "nt" and not demo:
        wsl_environment = wsl_solver()
        if wsl_environment is not None:
            commands, gpu_ready = wsl_environment
            backend, version = "wsl", "14"
            solver_problems = []
        else:
            solver_problems = ["Windows의 기본 WSL 배포판에서 OpenFOAM Foundation v14를 찾지 못했습니다."]
    return {
        "version": version, "commands": commands, "solver_ready": backend is not None,
        "solver_backend": backend, "solver_problems": solver_problems,
        "ready": backend is not None and not mesh_problems, "problems": solver_problems,
        "mesh_ready": not mesh_problems, "mesh_problems": mesh_problems,
        "gpu_pressure_ready": gpu_ready,
    }


def solver_command(environment, case, name, *arguments):
    executable = environment["commands"][name]
    if environment["solver_backend"] == "wsl":
        wsl = shutil.which("wsl.exe")
        if wsl is None:
            raise RuntimeError("WSL 실행 파일을 찾을 수 없습니다.")
        return [wsl, *wsl_distribution_args(), "--cd", "/", "--exec", "bash", "-c", WSL_RUN, "openfoam", str(case), executable, *arguments]
    return [executable, *arguments]


def number(body, field, label, *, minimum=None, maximum=None):
    value = body.get(field)
    if type(value) not in (int, float) or abs(value) > 1e100 or not math.isfinite(value):
        raise ValueError(f"{label}에 유효한 숫자를 입력하세요.")
    if minimum is not None and value < minimum:
        raise ValueError(f"{label}은 {minimum:g} 이상이어야 합니다.")
    if maximum is not None and value > maximum:
        raise ValueError(f"{label}은 {maximum:g} 이하여야 합니다.")
    return float(value)


def parse_conditions(body):
    mode, fluid = body.get("mode"), body.get("fluid")
    if mode not in ("steady", "transient"):
        raise ValueError("정상 또는 비정상 해석을 선택하세요.")
    if fluid not in FLUIDS:
        raise ValueError("유체 종류를 선택하세요.")
    outlet_mode = body.get("outlet_mode", "target")
    if outlet_mode not in ("ambient", "target"):
        raise ValueError("출구 경계조건을 선택하세요.")
    setup = {
        "mode": mode, "fluid": fluid,
        "rho": number(body, "rho", "밀도 (kg/m³)", minimum=1e-9),
        "mu": number(body, "mu", "동적 점도 (Pa·s)", minimum=1e-15),
        "inlet_speed_m_s": number(body, "inlet_speed_m_s", "입구 속도 (m/s)", minimum=0),
        "outlet_pressure_pa": 0.0 if outlet_mode == "ambient" else number(
            body, "outlet_pressure_pa", "출구 게이지 압력 (Pa)"),
        "end_time_s": None, "time_step_s": None,
    }
    compute = body.get("compute_backend", "cpu")
    if compute not in ("cpu", "gpu-pressure"):
        raise ValueError("해석 계산 장치를 선택하세요.")
    if "compute_backend" in body:
        setup["compute_backend"] = compute
    if "outlet_mode" in body:
        setup["outlet_mode"] = outlet_mode
    for key, label, minimum in (
        ("temperature_c", "기준 온도 (°C)", -273.149),
        ("reference_pressure_kpa", "기준 절대압 (kPa)", 1e-9),
    ):
        if key in body:
            setup[key] = number(body, key, label, minimum=minimum)
    if "inlet_kind" in body or "inlet_unit" in body:
        kind, unit = body.get("inlet_kind"), body.get("inlet_unit")
        units = {"speed": ("m/s", "cm/s", "mm/s"), "flow": ("mL/min", "L/min", "mL/s", "m³/s")}
        if not isinstance(kind, str) or unit not in units.get(kind, ()):
            raise ValueError("입구 조건과 단위를 확인하세요.")
        setup.update(inlet_kind=kind, inlet_unit=unit)
    if mode == "transient":
        if body.get("live") is True:
            setup["live"] = True
        end = number(body, "end_time_s", "해석 종료 시간 (s)", minimum=1e-9)
        count = body.get("step_count")
        step_mode = body.get("time_step_mode", "fixed" if count is not None else "adaptive")
        if step_mode not in ("adaptive", "fixed") or (step_mode == "fixed" and count is None):
            raise ValueError("시간 간격 방식과 스텝 수를 확인하세요.")
        if count is not None:
            if type(count) is not int or not 1 <= count <= 100_000:
                raise ValueError("시간 스텝 수는 1~100,000 사이의 정수로 입력하세요.")
            step = end / count
            if step < 1e-9:
                raise ValueError("계산 시간 간격은 1 ns 이상이어야 합니다.")
            setup["step_count" if step_mode == "fixed" else "requested_step_count"] = count
        else:
            step = number(body, "time_step_s", "시간 간격 (s)", minimum=1e-9, maximum=end)
        if count is None and end / step > 100_000:
            raise ValueError("비정상 해석은 최대 100,000 시간 단계까지 설정할 수 있습니다.")
        setup["time_step_mode"] = step_mode
        fixed_steps = step_mode == "fixed"
        if body.get("save_interval_s") is not None:
            interval = number(body,"save_interval_s","결과 저장 간격 (s)",minimum=1e-9,maximum=end)
            if end/interval > 200:
                raise ValueError("결과 저장 간격을 늘려 200개 이하의 시점으로 지정하세요.")
            if fixed_steps and not math.isclose(interval / step, round(interval / step), abs_tol=1e-7):
                raise ValueError("저장 간격을 계산 시간 간격의 정수배로 입력하세요.")
            setup["save_interval_s"] = interval
        schedule = body.get("flow_schedule", [])
        if not isinstance(schedule,list) or len(schedule)>100:
            raise ValueError("유량 표는 최대 100행입니다.")
        last = -1
        for entry in schedule:
            if not isinstance(entry,dict): raise ValueError("유량 표의 시간과 유량을 확인하세요.")
            t = number(entry,"time_s","변경 시각",minimum=0,maximum=end)
            number(entry,"ml_min","입구 유량",minimum=0)
            if t <= last or t >= end: raise ValueError("변경 시각을 종료 시간보다 작게, 증가하는 순서로 입력하세요.")
            if fixed_steps and not math.isclose(t / step, round(t / step), abs_tol=1e-7):
                raise ValueError("유량 변경 시각을 계산 시간 간격의 정수배로 입력하세요.")
            last = t
        if schedule: setup["flow_schedule"] = schedule
        if schedule or setup.get("save_interval_s"): setup["live"] = True
        setup.update(end_time_s=end, time_step_s=step)
    return setup


def require_mesh_method(method):
    if method not in MESH_METHODS:
        raise ValueError("지원하지 않는 격자 방식입니다.")
    return method


def parse(body):
    if not isinstance(body, dict) or not isinstance(body.get("document"), dict):
        raise ValueError("현재 CAD 프로젝트를 전송하세요.")
    inlet, outlet = body.get("inlet_ref"), body.get("outlet_ref")
    if not isinstance(inlet, str) or not isinstance(outlet, str) or inlet == outlet:
        raise ValueError("입구와 출구에 서로 다른 평면을 선택하세요.")
    mesh_only = body.get("mesh_only", False)
    if type(mesh_only) is not bool:
        raise ValueError("실행 방식이 올바르지 않습니다.")
    setup = parse_conditions(body)
    setup["mesh_method"] = require_mesh_method(body.get("mesh_method", DEFAULT_MESH_METHOD))
    if setup["mesh_method"] in HEX_MESH_METHODS:
        for key in ("width_cells", "height_cells"):
            if body.get(key) is not None:
                count = body[key]
                if type(count) is not int or not 2 <= count <= 512:
                    raise ValueError("단면 분할 수는 2~512 정수로 입력하세요.")
                setup[key] = count
    setup.update(mesh_only=mesh_only, mesh_mm=number(body, "mesh_mm", "목표 격자 크기 (mm)", minimum=0.0001))
    return setup, (inlet, outlet)


def apply_conditions(saved, changes):
    if not isinstance(changes, dict):
        raise ValueError("해석 조건을 JSON 객체로 보내세요.")
    conditions = {**saved, **changes}
    if "step_count" not in changes and "time_step_s" not in changes and "requested_step_count" in saved:
        conditions["step_count"] = saved["requested_step_count"]
    setup = parse_conditions(conditions)
    transient_keys = ("live", "flow_schedule", "save_interval_s", "step_count", "requested_step_count", "time_step_mode")
    return {**{k: v for k, v in saved.items() if k not in (*transient_keys, "refinement_group")}, **setup, "mesh_only": False}
