#!/usr/bin/env python3
"""Run the example's post-processor on synthetic plane-channel fields."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def write_field(path, kind, dimensions, count, rows):
    field_class = {"scalar": "volScalarField", "vector": "volVectorField"}[kind]
    with path.open("w", encoding="ascii", newline="\n") as output:
        output.write(
            "FoamFile\n{\n    version 2.0;\n    format ascii;\n"
            f"    class {field_class};\n    object {path.name};\n}}\n\n"
            f"dimensions {dimensions};\n"
            f"internalField nonuniform List<{kind}>\n{count}\n(\n"
        )
        output.writelines(f"{row}\n" for row in rows)
        output.write(");\n\nboundaryField {}\n")


def write_demo_fields(case):
    spec = json.loads((case / "benchmark.json").read_text(encoding="utf-8"))
    nx, ny = spec["nx"], spec["ny"]
    length, height = spec["length_m"], spec["height_m"]
    z = spec["extrusion_m"] / 2
    mean_speed = spec["u_mean_m_s"]
    xs = [(i + 0.5) * length / nx for i in range(nx)]
    ys = [(j + 0.5) * height / ny for j in range(ny)]
    cell_count = nx * ny

    # Use a 1% offset in each field to exercise both error metrics.
    kinematic_gradient = 1.01 * 12 * spec["nu_m2_s"] * mean_speed / height**2
    kinematic_pressures = [kinematic_gradient * (length - x) for x in xs]
    ratios = [y / height for y in ys]
    velocities = [0.99 * 6 * mean_speed * eta * (1 - eta) for eta in ratios]

    time = case / "1"
    time.mkdir()
    write_field(
        time / "C", "vector", "[0 1 0 0 0 0 0]", cell_count,
        (f"({x:.14g} {y:.14g} {z:.14g})" for y in ys for x in xs),
    )
    write_field(
        time / "U", "vector", "[0 1 -1 0 0 0 0]", cell_count,
        (f"({speed:.14g} 0 0)" for speed in velocities for _ in xs),
    )
    write_field(
        time / "p", "scalar", "[0 2 -2 0 0 0 0]", cell_count,
        (f"{pressure:.14g}" for _ in ys for pressure in kinematic_pressures),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", type=Path, help="fresh case from make_case.py")
    case = parser.parse_args().case.resolve()
    sys.stdout.reconfigure(encoding="utf-8")
    print("[테스트 데이터] 합성 압력·속도 필드로 후처리를 실행합니다.", flush=True)
    write_demo_fields(case)
    environment = dict(os.environ, PYTHONIOENCODING="utf-8")
    return subprocess.run(
        [sys.executable, "-u", "analyse.py"], cwd=case, env=environment,
    ).returncode


if __name__ == "__main__":
    sys.exit(main())
