"""Build and read a serial OpenFOAM 14 case for a meshed CAD fluid volume."""

import argparse
import csv
import json
import math
import re
from pathlib import Path

PATCHES = frozenset(("inlet", "outlet", "walls"))
PROFILE_FIELDS = ("x_m", "y_m", "z_m", "ux_m_s", "uy_m_s", "uz_m_s", "speed_m_s", "pressure_pa")
PROFILE_LIMIT = 700
NUMERIC_SUMMARY_FIELDS = (
    "inlet_pressure_pa", "outlet_pressure_pa", "pressure_drop_pa", "max_speed_m_s", "mean_speed_m_s",
    "inlet_mesh_area_m2", "outlet_mesh_area_m2",
)
OPTIONAL_SUMMARY_FIELDS = ("inlet_phi_m3_s", "outlet_phi_m3_s", "flux_imbalance_percent")
FOAM_COMMENTS = re.compile(r"/\*.*?\*/|//[^\r\n]*", re.DOTALL)
PATCH_BLOCK = re.compile(r"\b([A-Za-z_]\w*)\s*\{([^{}]*)\}")
FACE = re.compile(r"(\d+)\s*\(([\d\s]+)\)")


def foam_number(number):
    return format(number if number != 0 else 0, ".15g")


def foam_file(case, location, name, kind, contents):
    header = f"""FoamFile
{{
    version 2.0;
    format ascii;
    class {kind};
    location "{location}";
    object {name};
}}

"""
    (case / location / name).write_text(header + contents, encoding="utf-8")


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")


def prepare(case, setup):
    """Write initial fields and dictionaries, preserving any geometry saved in case."""
    for location in ("0", "constant", "system"):
        (case / location).mkdir(parents=True, exist_ok=True)

    normal = setup["inlet"]["normal"]
    inlet = " ".join(foam_number(-component * setup["inlet_speed_m_s"]) for component in normal)
    outlet_p = foam_number(setup["outlet_pressure_pa"] / setup["rho"])
    nu = foam_number(setup["mu"] / setup["rho"])
    outlet_boundary = f"type fixedValue; value uniform {outlet_p};"
    if setup.get("outlet_mode") == "ambient":
        outlet_boundary = "type totalPressure; p0 uniform 0; value uniform 0;"
    foam_file(case, "0", "U", "volVectorField", f"""dimensions [0 1 -1 0 0 0 0];
internalField uniform (0 0 0);
boundaryField
{{
    inlet  {{ type fixedValue; value uniform ({inlet}); }}
    outlet {{ type pressureInletOutletVelocity; value uniform (0 0 0); }}
    walls  {{ type noSlip; }}
    defaultFaces {{ type zeroGradient; }}
}}
""")
    foam_file(case, "0", "p", "volScalarField", f"""dimensions [0 2 -2 0 0 0 0];
internalField uniform {outlet_p};
boundaryField
{{
    inlet  {{ type zeroGradient; }}
    outlet {{ {outlet_boundary} }}
    walls  {{ type zeroGradient; }}
    defaultFaces {{ type zeroGradient; }}
}}
""")
    foam_file(case, "constant", "physicalProperties", "dictionary",
              f"viscosityModel constant;\nnu [0 2 -1 0 0 0 0] {nu};\n")
    foam_file(case, "constant", "momentumTransport", "dictionary", "simulationType laminar;\n")

    transient = setup["mode"] == "transient"
    if transient:
        end = foam_number(setup["end_time_s"])
        timestep = foam_number(setup["time_step_s"])
        write_control, write_interval = "adjustableRunTime", end
        time_controls = f"adjustTimeStep yes;\nmaxCo 0.5;\nmaxDeltaT {timestep};\n"
        if setup.get("step_count"):
            time_controls = "adjustTimeStep no;\n"
            write_control, write_interval = "timeStep", setup["step_count"]
        algorithm = """PIMPLE
{
    momentumPredictor yes;
    nOuterCorrectors 2;
    nCorrectors 2;
    nNonOrthogonalCorrectors 2;
}
"""
    else:
        end, timestep = 2000, 1
        write_control, write_interval = "timeStep", 100
        time_controls = ""
        algorithm = """SIMPLE
{
    nNonOrthogonalCorrectors 2;
    residualControl { p 1e-7; U 1e-7; }
}
relaxationFactors
{
    fields    { p 0.3; }
    equations { U 0.7; }
}
"""
    gpu_pressure = setup.get("compute_backend") == "gpu-pressure" and not setup.get("mesh_only")
    pressure_library = 'libs ("libflowformGpuPressure.so");\n' if gpu_pressure else ""
    foam_file(case, "system", "controlDict", "dictionary", f"""application foamRun;
solver incompressibleFluid;
startFrom startTime;
startTime 0;
stopAt endTime;
endTime {end};
deltaT {timestep};
writeControl {write_control};
writeInterval {write_interval};
purgeWrite 2;
writeFormat ascii;
writePrecision 12;
writeCompression off;
timeFormat general;
timePrecision 14;
runTimeModifiable no;
{time_controls}{pressure_library}""")
    foam_file(case, "system", "functions", "dictionary", """flowformStop
{
    type stopAtFile;
    libs ("libutilityFunctionObjects.so");
    action writeNow;
}
""")
    time_scheme = "Euler" if transient else "steadyState"
    convection = "Gauss upwind" if transient else "bounded Gauss upwind"
    foam_file(case, "system", "fvSchemes", "dictionary", f"""ddtSchemes {{ default {time_scheme}; }}
gradSchemes {{ default Gauss linear; }}
divSchemes
{{
    default none;
    div(phi,U) {convection};
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}}
laplacianSchemes {{ default Gauss linear limited corrected 0.5; }}
interpolationSchemes {{ default linear; }}
snGradSchemes {{ default limited corrected 0.5; }}
""")
    solution = """solvers
{
    p
    {
        solver GAMG;
        smoother GaussSeidel;
        tolerance 1e-9;
        relTol 0.05;
    }
    pFinal { $p; relTol 0; }
    U
    {
        solver smoothSolver;
        smoother symGaussSeidel;
        tolerance 1e-9;
        relTol 0.05;
    }
    UFinal { $U; relTol 0; }
}
""" + algorithm
    if gpu_pressure:
        solution = solution.replace("solver GAMG;\n        smoother GaussSeidel;", "solver FlowFormCuDSS;", 1)
    foam_file(case, "system", "fvSolution", "dictionary", solution)
    write_json(case / "setup.json", setup)


def foam_text(path):
    return FOAM_COMMENTS.sub("", path.read_text(encoding="utf-8"))


def mesh_list(path):
    text = foam_text(path)
    match = re.search(r"\bFoamFile\s*\{([^{}]*)\}\s*(\d+)\s*([({])(.*)[)}]\s*$", text, re.DOTALL)
    if not match or not re.search(r"\bformat\s+ascii\s*;", match[1]):
        raise ValueError(f"{path.name} 메쉬 목록의 ASCII 형식을 읽을 수 없습니다.")
    return int(match[2]), match[3], match[4]


def boundary_patches(path):
    count, opening, block = mesh_list(path)
    patches = {}
    for patch in PATCH_BLOCK.finditer(block):
        name, entries = patch.groups()
        start = re.search(r"\bstartFace\s+(\d+)\s*;", entries)
        size = re.search(r"\bnFaces\s+(\d+)\s*;", entries)
        if start is None or size is None or name in patches:
            raise ValueError(f"{name} 경계 패치를 읽을 수 없습니다.")
        patches[name] = (int(start[1]), int(size[1]))
    if opening != "(" or count != len(patches) or any(not patches.get(name, (0, 0))[1] for name in PATCHES):
        raise ValueError("격자에서 입구, 출구 또는 벽 패치를 찾을 수 없습니다.")
    if set(patches) - PATCHES - {"defaultFaces"} or patches.get("defaultFaces", (0, 0))[1]:
        raise ValueError("입구, 출구, 벽 이외에 할당되지 않은 격자 경계가 있습니다.")
    return patches


def set_wall_type(case):
    """Promote the walls physical surface to the OpenFOAM wall patch type."""
    path = case / "constant" / "polyMesh" / "boundary"
    boundary_patches(path)
    text = path.read_text(encoding="utf-8")
    adjusted, count = re.subn(r"(\bwalls\s*\{[^{}]*?\btype\s+)(?:patch|wall)(?=\s*;)", r"\g<1>wall",
                             text, count=1)
    if count != 1:
        raise ValueError("벽 경계 패치의 종류를 확인할 수 없습니다.")
    if adjusted != text:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(adjusted, encoding="utf-8")
        temporary.replace(path)


def labels(path):
    count, opening, values = mesh_list(path)
    if opening == "{":
        parsed = [int(values.strip())] * count
    else:
        parsed = list(map(int, values.split()))
    if len(parsed) != count or (parsed and min(parsed) < 0):
        raise ValueError(f"{path.name} 격자 번호 목록이 올바르지 않습니다.")
    return parsed


def vector_rows(text, count):
    values = [tuple(map(float, match[1].split())) for match in re.finditer(r"\(([^()]*)\)", text)]
    if len(values) != count or any(len(row) != 3 or not all(map(math.isfinite, row)) for row in values):
        raise ValueError("OpenFOAM 좌표 또는 속도 벡터를 읽을 수 없습니다.")
    return values


def field_values(text, keyword, kind, count):
    size = 3 if kind == "vector" else 1
    field = re.search(rf"\b{keyword}\s+(uniform|nonuniform)\s+([^;]+);", text)
    if field is None:
        raise ValueError(f"{keyword} 필드 값을 찾을 수 없습니다.")
    if field[1] == "uniform":
        row = tuple(map(float, field[2].strip().strip("()").split()))
        if len(row) == size and all(map(math.isfinite, row)):
            return [row if size == 3 else row[0]] * count
    else:
        if count == 0 and field[2].strip() in ("0()", "0 ()", "0"):
            return []
        block = re.fullmatch(rf"List<\s*{kind}\s*>\s+(\d+)\s*\((.*)\)\s*", field[2], re.DOTALL)
        if block and int(block[1]) == count:
            if size == 3:
                return vector_rows(block[2], count)
            rows = list(map(float, block[2].split()))
            if len(rows) == count and all(map(math.isfinite, rows)):
                return rows
    raise ValueError(f"{keyword} 필드에 유효한 {count}개 값이 없습니다.")


def latest_time(case):
    candidates = []
    for directory in case.iterdir():
        if not directory.is_dir():
            continue
        try:
            instant = float(directory.name)
        except ValueError:
            continue
        if math.isfinite(instant) and instant > 0 and all((directory / field).is_file() for field in ("p", "U")):
            candidates.append((instant, directory))
    if not candidates:
        raise ValueError("해석 시간 폴더에 계산한 압력과 속도 필드가 없습니다.")
    return max(candidates)[1]


def face_area(points, ids):
    origin = points[ids[0]]
    vectors = [tuple(value - offset for value, offset in zip(points[index], origin)) for index in ids[1:]]
    cross_products = (
        (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
        for a, b in zip(vectors, vectors[1:])
    )
    return 0.5 * math.hypot(*(math.fsum(axis) for axis in zip(*cross_products)))


def mesh_points(mesh):
    count, opening, rows = mesh_list(mesh / "points")
    if opening != "(":
        raise ValueError("OpenFOAM 격자 점 목록을 읽을 수 없습니다.")
    return vector_rows(rows, count)


def mesh_faces(mesh, owner_count, point_count):
    count, opening, text = mesh_list(mesh / "faces")
    if opening != "(" or count != owner_count:
        raise ValueError("격자 면과 소유 셀 목록의 길이가 일치하지 않습니다.")
    parsed = 0
    for face in FACE.finditer(text):
        ids = tuple(map(int, face[2].split()))
        if len(ids) < 3 or len(ids) != int(face[1]) or max(ids) >= point_count:
            raise ValueError("격자 면의 점 목록이 올바르지 않습니다.")
        parsed += 1
        yield ids
    if parsed != count:
        raise ValueError("OpenFOAM 격자 면 목록을 읽을 수 없습니다.")


def mesh_geometry(case):
    mesh = case / "constant" / "polyMesh"
    patches = boundary_patches(mesh / "boundary")
    owners = labels(mesh / "owner")
    neighbours = labels(mesh / "neighbour")
    cells = 1 + max(max(owners, default=-1), max(neighbours, default=-1))
    if not cells:
        raise ValueError("OpenFOAM 격자에 계산 셀이 없습니다.")
    end_patches = ("inlet", "outlet")
    spans = {name: range(start, start + size) for name, (start, size) in patches.items() if name in end_patches}
    if any(span.stop > len(owners) for span in spans.values()):
        raise ValueError("격자 면과 경계 패치 범위가 일치하지 않습니다.")
    points = mesh_points(mesh)
    areas = {name: [] for name in end_patches}
    for face_index, ids in enumerate(mesh_faces(mesh, len(owners), len(points))):
        for name, span in spans.items():
            if face_index in span:
                area = face_area(points, ids)
                if not math.isfinite(area) or area <= 0:
                    raise ValueError("입구 또는 출구에서 유효하지 않은 격자 면을 찾았습니다.")
                areas[name].append((owners[face_index], area))
    if any(len(areas[name]) != len(spans[name]) for name in end_patches):
        raise ValueError("입구 또는 출구의 격자 면을 읽을 수 없습니다.")
    return cells, areas


def patch_content(text, name):
    entries = re.search(rf"\b{name}\s*\{{([^{{}}]*)\}}", text)
    return entries[1] if entries else ""


def patch_fluxes(time, areas):
    phi = time / "phi"
    if not phi.is_file():
        return None, None
    text = foam_text(phi)
    flow = []
    for name in ("inlet", "outlet"):
        entries = patch_content(text, name)
        if re.search(r"\bvalue\b", entries):
            flow.append(math.fsum(field_values(entries, "value", "scalar", len(areas[name]))))
        else:
            flow.append(None)
    return tuple(flow)


def area_average(pressures, faces, total_area):
    return math.fsum(pressure * area for pressure, (_, area) in zip(pressures, faces)) / total_area


def analyse(case, setup):
    """Extract SI-unit fields and pressure drop from the latest solved time."""
    time = latest_time(case)
    if setup["mode"] == "transient" and not math.isclose(float(time.name), setup["end_time_s"], rel_tol=1e-8):
        raise ValueError("설정한 종료 시각의 비정상 유동 결과를 찾을 수 없습니다.")
    cells, areas = mesh_geometry(case)
    centres = field_values(foam_text(time / "C"), "internalField", "vector", cells)
    velocity = field_values(foam_text(time / "U"), "internalField", "vector", cells)
    pressure_text = foam_text(time / "p")
    pressure = field_values(pressure_text, "internalField", "scalar", cells)
    rho = setup["rho"]
    inlet_area = math.fsum(area for _, area in areas["inlet"])
    outlet_area = math.fsum(area for _, area in areas["outlet"])
    # The inlet's zeroGradient condition copies the owner-cell pressure onto each face.
    inlet_pressure = area_average((pressure[owner] for owner, _ in areas["inlet"]), areas["inlet"], inlet_area) * rho
    outlet_values = field_values(patch_content(pressure_text, "outlet"), "value", "scalar", len(areas["outlet"]))
    outlet_pressure = area_average(outlet_values, areas["outlet"], outlet_area) * rho
    q_in, q_out = patch_fluxes(time, areas)
    imbalance = 100 * abs(q_in + q_out) / abs(q_in) if q_in and q_out is not None else None
    solver_log = case / "log.foamRun"
    converged = None
    if setup["mode"] == "steady" and solver_log.is_file():
        with solver_log.open(encoding="utf-8", errors="replace") as source:
            converged = any("SIMPLE solution converged" in line for line in source)

    analysis = case / "analysis"
    analysis.mkdir(exist_ok=True)
    sample_size = min(cells, PROFILE_LIMIT)
    sample_indices = {0}
    if sample_size > 1:
        sample_indices = {index * (cells - 1) // (sample_size - 1) for index in range(sample_size)}
    profile = []
    speeds = [math.hypot(*vector) for vector in velocity]
    with (analysis / "profile.csv").open("w", encoding="utf-8", newline="") as output:
        rows = csv.writer(output)
        rows.writerow(PROFILE_FIELDS)
        for index, (point, vector, speed, p) in enumerate(zip(centres, velocity, speeds, pressure)):
            row = (*point, *vector, speed, p * rho)
            if index in sample_indices:
                profile.append(dict(zip(PROFILE_FIELDS, row)))
            rows.writerow(row)

    summary = {
        "mode": setup["mode"], "time_directory": time.name, "cells": cells,
        "inlet_pressure_pa": inlet_pressure, "outlet_pressure_pa": outlet_pressure,
        "pressure_drop_pa": inlet_pressure - outlet_pressure,
        "max_speed_m_s": max(speeds), "mean_speed_m_s": math.fsum(speeds) / cells,
        "inlet_mesh_area_m2": inlet_area, "outlet_mesh_area_m2": outlet_area,
        "inlet_phi_m3_s": q_in, "outlet_phi_m3_s": q_out, "flux_imbalance_percent": imbalance,
        "steady_converged": converged,
    }
    write_json(analysis / "profile.json", profile)
    write_json(analysis / "summary.json", summary)
    return summary, profile


def read_results(case):
    analysis = case / "analysis"
    summary = json.loads((analysis / "summary.json").read_text(encoding="utf-8"))
    profile = json.loads((analysis / "profile.json").read_text(encoding="utf-8"))
    cells = summary["cells"]
    if type(cells) is not int or cells < 1 or len(profile) != min(cells, PROFILE_LIMIT):
        raise ValueError("저장된 격자 수와 속도 표본이 일치하지 않습니다.")
    values = [summary[key] for key in NUMERIC_SUMMARY_FIELDS]
    values.extend(summary[key] for key in OPTIONAL_SUMMARY_FIELDS if summary[key] is not None)
    values.extend(point[key] for point in profile for key in PROFILE_FIELDS)
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in values):
        raise ValueError("저장된 CFD 결과에 유효하지 않은 수치가 있습니다.")
    if not (analysis / "profile.csv").is_file():
        raise ValueError("저장된 CFD 결과의 CSV를 찾을 수 없습니다.")
    return summary, profile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("wall-type", "analyse"))
    parser.add_argument("case", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "wall-type":
            set_wall_type(args.case)
        else:
            setup = json.loads((args.case / "setup.json").read_text(encoding="utf-8"))
            summary, _ = analyse(args.case, setup)
            print(json.dumps(summary, ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()


def residual_progress(log):
    """Report started time steps and the largest initial residual per field in each."""
    if not log.is_file():
        return {"step": 0, "time": None, "residuals": []}
    rows = {}
    number = r"[-+0-9.eE]+"
    time_pattern = re.compile(rf"^Time\s*=\s*({number})")
    field_pattern = re.compile(rf"Solving for (Ux|Uy|Uz|p), Initial residual = ({number})")
    row = None
    with log.open(encoding="utf-8", errors="replace") as lines:
        for line in lines:
            match = time_pattern.match(line)
            if match:
                time = float(match[1])
                row = rows.setdefault(time, {"time": time}) if math.isfinite(time) else None
            match = field_pattern.search(line)
            if match and row is not None:
                field, value = match[1], float(match[2])
                if math.isfinite(value):
                    row[field] = max(row.get(field, 0), value)
    return {"step": len(rows), "time": max(rows, default=None),
            "residuals": [row for _, row in sorted(rows.items()) if len(row) > 1]}


def residual_history(log):
    """Largest initial residual per field and time across corrector passes."""
    return residual_progress(log)["residuals"]
