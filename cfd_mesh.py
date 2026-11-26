"""Generate a tetrahedral Gmsh mesh for the exact CAD fluid volume."""

import argparse
import json
import math
import os
from pathlib import Path


MAX_CELLS = 500_000
ESTIMATED_CELL_LIMIT = 300_000
PATCH_IDS = {"inlet": 1, "outlet": 2, "walls": 3}


def positive_number(value, label):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{label} 값은 0보다 큰 유한한 수여야 합니다.")
    return value


def coordinates(values, expected):
    if not isinstance(values, list) or len(values) != expected or any(
        type(value) not in (int, float) or not math.isfinite(value) for value in values
    ):
        raise ValueError("입출구 면 좌표가 올바르지 않습니다.")
    return values


def near_coordinates(first, second, tolerance):
    return all(
        math.isclose(left, right, abs_tol=tolerance, rel_tol=1e-10)
        for left, right in zip(first, second)
    )


def match_face(gmsh, surfaces, descriptor, label):
    center = coordinates(descriptor["center_mm"], 3)
    bounds = coordinates(descriptor["bounds_mm"], 6)
    area = positive_number(descriptor["area_mm2"], f"{label} 면적")
    occ = gmsh.model.occ
    matches = [
        tag for tag in surfaces
        if gmsh.model.getType(2, tag) == "Plane"
        and near_coordinates(center, occ.getCenterOfMass(2, tag), 1e-5)
        and math.isclose(area, occ.getMass(2, tag), abs_tol=1e-9, rel_tol=1e-5)
    ]
    if len(matches) > 1:
        matches = [
            tag for tag in matches
            if near_coordinates(bounds, occ.getBoundingBox(2, tag), 1e-4)
        ]
    if len(matches) != 1:
        raise ValueError(f"STEP에서 {label} 면을 하나로 찾지 못했습니다. CAD에서 경계면을 다시 선택하세요.")
    return matches[0]


def elements(gmsh, dimension, tag, element_type):
    types, labels, _ = gmsh.model.mesh.getElements(dimension, tag)
    if len(types) != 1 or types[0] != element_type or not len(labels[0]):
        raise ValueError("생성된 격자에 필요한 선형 삼각형 또는 사면체가 없습니다.")
    return labels[0]


def configure(gmsh, size):
    # Generate in CAD millimetres to preserve OCC tolerances. Export in metres for OpenFOAM.
    settings = {
        "General.NumThreads": 1,
        "Mesh.Algorithm": 6,
        "Mesh.Algorithm3D": 1,
        "Mesh.ElementOrder": 1,
        "Mesh.MeshSizeFromPoints": 0,
        "Mesh.MeshSizeFromCurvature": 24,
        "Mesh.MeshSizeMin": size / 4,
        "Mesh.MeshSizeMax": size,
        "Mesh.MshFileVersion": 2.2,
        "Mesh.Binary": 0,
        "Mesh.SaveAll": 0,
        "Mesh.ScalingFactor": 1e-3,
    }
    for name, value in settings.items():
        gmsh.option.setNumber(name, value)
    gmsh.option.setString("Geometry.OCCTargetUnit", "MM")


def build_mesh(gmsh, setup):
    size = positive_number(setup["mesh_mm"], "격자 크기")
    configure(gmsh, size)
    gmsh.model.add("fluid_domain")
    occ = gmsh.model.occ
    occ.importShapes("domain.step")
    occ.synchronize()
    volumes = gmsh.model.getEntities(3)
    if len(volumes) != 1:
        raise ValueError("하나로 연결된 유체 체적만 격자화할 수 있습니다.")
    _, volume = volumes[0]
    boundaries = gmsh.model.getBoundary(volumes, oriented=False)
    surfaces = [tag for dimension, tag in boundaries if dimension == 2]

    inlet = match_face(gmsh, surfaces, setup["inlet"], "입구")
    outlet = match_face(gmsh, surfaces, setup["outlet"], "출구")
    if inlet == outlet:
        raise ValueError("입구와 출구는 서로 다른 면이어야 합니다.")
    if setup.get("mesh_method") in ("hex-sweep", "hex-dominant"):
        from cfd_sweep import generate
        return generate(gmsh, setup, surfaces, volume, inlet, outlet, size, ESTIMATED_CELL_LIMIT)
    walls = [tag for tag in surfaces if tag not in (inlet, outlet)]
    if not walls:
        raise ValueError("입구와 출구 외에 유체 체적의 벽면이 필요합니다.")

    volume_mm3 = positive_number(occ.getMass(3, volume), "유체 체적")
    area_mm2 = sum(occ.getMass(2, tag) for tag in surfaces)
    # A tetrahedron with edge h occupies about h³/8. Bound surface work separately
    # for thin shapes where the volume alone understates the mesh cost.
    if 8 * volume_mm3 / size**3 + 4 * area_mm2 / size**2 > ESTIMATED_CELL_LIMIT:
        raise ValueError("예상 격자 수가 너무 큽니다. 목표 셀 크기(mm)를 키우세요.")

    patches = {"inlet": [inlet], "outlet": [outlet], "walls": walls}
    for name, tags in patches.items():
        gmsh.model.addPhysicalGroup(2, tags, PATCH_IDS[name], name)
    gmsh.model.addPhysicalGroup(3, [volume], 4, "fluid")
    if setup.get("mesh_method") == "tetra-hxt":
        gmsh.option.setNumber("Mesh.Algorithm3D", 10)
    gmsh.model.mesh.generate(3)

    tetrahedra = elements(gmsh, 3, volume, 4)
    if len(tetrahedra) > MAX_CELLS:
        raise ValueError(f"격자가 {MAX_CELLS:,}셀을 넘어 저장할 수 없습니다. 목표 셀 크기(mm)를 키우세요.")
    patch_faces = {
        name: sum(len(elements(gmsh, 2, tag, 2)) for tag in tags)
        for name, tags in patches.items()
    }
    quality = float(min(gmsh.model.mesh.getElementQualities(tetrahedra, "minSICN")))
    if not math.isfinite(quality) or quality <= 0:
        raise ValueError("품질 지표가 0 이하인 사면체가 있습니다. 격자 크기나 형상을 조정하세요.")
    gmsh.write("domain.msh")
    return {
        "method": setup.get("mesh_method", "gmsh-tetra"),
        "mesh_mm": size,
        "cells": len(tetrahedra),
        "nodes": len(gmsh.model.mesh.getNodes()[0]),
        "patch_faces": patch_faces,
        "inlet_area_mm2": occ.getMass(2, inlet),
        "outlet_area_mm2": occ.getMass(2, outlet),
        "volume_mm3": volume_mm3,
        "quality_min_sicn": quality,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case_dir", type=Path)
    args = parser.parse_args()
    try:
        import gmsh
    except (ImportError, OSError) as error:
        parser.exit(1, f"Gmsh를 불러올 수 없습니다. README의 설치 방법을 확인하세요. {error}\n")

    try:
        os.chdir(args.case_dir)
        setup = json.loads(Path("setup.json").read_text(encoding="utf-8"))
        gmsh.initialize([], readConfigFiles=False)
        try:
            report = build_mesh(gmsh, setup)
            Path("mesh.json").write_text(
                json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8",
            )
        finally:
            gmsh.finalize()
    except Exception as error:
        # Gmsh exposes C++ API failures as plain Python Exception objects.
        parser.exit(1, f"유체 체적의 격자 생성에 실패했습니다. {error}\n")


if __name__ == "__main__":
    main()
