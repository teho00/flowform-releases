#!/usr/bin/env python3
"""Create a fresh OpenFOAM Foundation v14 plane-channel case."""

import argparse
import json
import shutil
import tempfile
from pathlib import Path


BASE = Path(__file__).resolve().parent / "channel20"
FIXED = (
    "0/p", "system/controlDict", "system/fvSchemes", "system/fvSolution",
    "constant/momentumTransport", "Allrun", "analyse.py",
)


def foam_header(kind, name):
    return (
        "FoamFile\n{\n    version 2.0;\n    format ascii;\n"
        f"    class {kind};\n    object {name};\n}}\n\n"
    )


def write_inputs(case, ny):
    h = 0.001
    length = 0.020
    b = 0.001
    rho = 1.20
    nu = 1.50e-5
    u_mean = 1.0
    nx = 10 * ny
    spec = {
        "length_m": length, "height_m": h, "extrusion_m": b,
        "rho_kg_m3": rho, "nu_m2_s": nu, "u_mean_m_s": u_mean,
        "nx": nx, "ny": ny,
    }
    (case / "benchmark.json").write_text(json.dumps(spec, indent=2) + "\n")

    # Integrate 6*eta*(1-eta) over each inlet face, eta = y/H.
    def primitive(eta):
        return 3 * eta**2 - 2 * eta**3

    inlet = [u_mean * ny * (primitive((j+1)/ny) - primitive(j/ny))
             for j in range(ny)]
    profile = "\n".join(f"            ({ux:.13g} 0 0)" for ux in inlet)
    data = foam_header("volVectorField", "U") + f"""dimensions [0 1 -1 0 0 0 0];
internalField uniform ({u_mean:g} 0 0);

boundaryField
{{
    inlet
    {{
        type fixedValue;
        value nonuniform List<vector>
        {ny}
        (
{profile}
        );
    }}
    outlet       {{ type zeroGradient; }}
    walls        {{ type noSlip; }}
    frontAndBack {{ type empty; }}
}}
"""
    (case / "0/U").write_text(data)

    mesh = foam_header("dictionary", "blockMeshDict") + f"""vertices
(
    (0 0 0)   ({length} 0 0)   ({length} {h} 0)   (0 {h} 0)
    (0 0 {b}) ({length} 0 {b}) ({length} {h} {b}) (0 {h} {b})
);
blocks
(
    hex (0 1 2 3 4 5 6 7) ({nx} {ny} 1) simpleGrading (1 1 1)
);
edges ();
boundary
(
    inlet
    {{
        type patch;
        faces ((0 4 7 3));
    }}
    outlet
    {{
        type patch;
        faces ((1 2 6 5));
    }}
    walls
    {{
        type wall;
        faces ((0 1 5 4) (3 7 6 2));
    }}
    frontAndBack
    {{
        type empty;
        faces ((0 3 2 1) (4 5 6 7));
    }}
);
mergePatchPairs ();
"""
    (case / "system/blockMeshDict").write_text(mesh)
    props = foam_header("dictionary", "physicalProperties")
    props += f"viscosityModel constant;\nnu [0 2 -1 0 0 0 0] {nu:.12g};\n"
    (case / "constant/physicalProperties").write_text(props)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new case directory")
    parser.add_argument("--ny", type=int, default=20, help="even cells across the gap")
    args = parser.parse_args()
    if args.ny < 4 or args.ny % 2:
        parser.error("--ny must be even and >= 4")
    target = args.output.resolve()
    if target.exists():
        parser.error(f"{target} already exists. Choose a new directory name.")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as temp:
        case = Path(temp) / "new-case"
        for name in FIXED:
            dest = case / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(BASE / name, dest)
        write_inputs(case, args.ny)
        case.rename(target)
    print(f"Created {target} ({10*args.ny} x {args.ny} x 1 cells).")


if __name__ == "__main__":
    main()
