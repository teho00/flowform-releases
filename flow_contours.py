"""Display OpenFOAM cell and boundary fields on the solved polyMesh."""

from dataclasses import dataclass
from functools import lru_cache
import math
import re

import cfd_case
from cfd_mesh import MAX_CELLS
from mesh_preview import PreviewSample, SECTION_LIMIT, cut_polygon


FIELDS = {"pressure": ("p", "scalar", "Pa"), "speed": ("U", "vector", "m/s")}
SURFACE_LIMIT = 46_000


@lru_cache(maxsize=32)
def tetra_orthogonality(case, cells):
    """Minimum face-normal alignment with cell-to-face and cell-to-cell vectors."""
    mesh = case / "constant/polyMesh"
    points = cfd_case.mesh_points(mesh)
    owners = cfd_case.labels(mesh / "owner")
    neighbours = cfd_case.labels(mesh / "neighbour")
    time = cfd_case.latest_time(case)
    centres = cfd_case.field_values(cfd_case.foam_text(time / "C"), "internalField", "vector", cells)
    worst = 1.0
    for i, face in enumerate(cfd_case.mesh_faces(mesh, len(owners), len(points))):
        if len(face) != 3:
            return None
        a, b, c = (points[v] for v in face)
        u, v = ([p - q for p, q in zip(point, a)] for point in (b, c))
        normal = (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])
        area = math.hypot(*normal)
        middle = tuple(sum(coords)/3 for coords in zip(a, b, c))
        owner = centres[owners[i]]
        pairs = [(owner, middle)]
        if i < len(neighbours):
            neighbour = centres[neighbours[i]]
            pairs.extend(((middle, neighbour), (owner, neighbour)))
        for start, end in pairs:
            d = tuple(y - x for x, y in zip(start, end))
            length = area * math.hypot(*d)
            align = sum(x*y for x, y in zip(normal, d)) / length if length else 0.0
            worst = min(worst, max(0.0, align))
    return worst


@lru_cache(maxsize=12)
def timeline(case, rho, cells, area):
    """Index immutable snapshots after the run ends; use one scale for all frames."""
    folder = case / "live"
    times = sorted((p for p in folder.iterdir() if p.is_dir() and
                    re.fullmatch(r"[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", p.name)
                    and all((p / name).is_file() for name in ("p", "U"))),
                   key=lambda p: float(p.name)) if folder.is_dir() else []
    frames, limits = [], {}
    if times:
        poly = case / "constant/polyMesh"
        patches = cfd_case.boundary_patches(poly / "boundary")
        owners = cfd_case.labels(poly / "owner")
        _, areas = cfd_case.mesh_geometry(case)
        for time in times:
            drop = None
            for field in FIELDS:
                internal, boundary = read_field(time, field, cells, rho, patches, owners)
                arrays = [internal, *boundary.values()]
                lo, hi = min(map(min, arrays)), max(map(max, arrays))
                previous = limits.get(field, (lo, hi))
                limits[field] = min(lo, previous[0]), max(hi, previous[1])
                if field == "pressure":
                    def mean(patch):
                        weights = [a for _, a in areas[patch]]
                        return sum(v*w for v,w in zip(boundary[patch],weights))/sum(weights)
                    drop = mean("inlet") - mean("outlet")
                if field == "speed":
                    # The workspace prescribes one uniform normal velocity on the inlet.
                    frames.append({"time": time.name, "ml_min": boundary["inlet"][0] * area * 60, "pressure_drop_pa": drop})
    return {"frames": frames, "limits": limits}


@dataclass
class SolvedMesh:
    points: list
    bounds: list
    faces: list
    owners: list
    neighbours: list
    patches: dict
    fields: dict
    boundaries: dict


def read_field(time, field, cells, rho, patches, owners):
    filename, kind, _ = FIELDS[field]
    text = cfd_case.foam_text(time / filename)
    convert = math.hypot if kind == "vector" else None
    raw = cfd_case.field_values(text, "internalField", kind, cells)
    values = [convert(*row) for row in raw] if convert else [value * rho for value in raw]
    boundary = {}
    for name, (start, size) in patches.items():
        if not size:
            continue
        block = cfd_case.patch_content(text, name)
        if re.search(r"\bvalue\s+(?:uniform|nonuniform)\b", block):
            raw = cfd_case.field_values(block, "value", kind, size)
            data = [convert(*row) for row in raw] if convert else [value * rho for value in raw]
        elif kind == "vector" and re.search(r"\btype\s+noSlip\s*;", block):
            data = [0.0] * size
        else:
            data = [values[owner] for owner in owners[start:start + size]]
        boundary[name] = data
    if any(not math.isfinite(value) for value in values) or any(
        not math.isfinite(value) for patch in boundary.values() for value in patch
    ):
        raise ValueError("컨투어에 표시할 필드에 유한하지 않은 값이 있습니다.")
    return values, boundary


@lru_cache(maxsize=1)
def load(case, time_name, rho, expected_cells, live=False):
    """Load one result at a time. Completed cases have immutable fields."""
    mesh = case / "constant" / "polyMesh"
    time = case / "live" / time_name if live else cfd_case.latest_time(case)
    if time.name != time_name:
        raise ValueError("저장 결과와 OpenFOAM 필드의 시점이 일치하지 않습니다.")
    owners, neighbours = (cfd_case.labels(mesh / name) for name in ("owner", "neighbour"))
    cells = 1 + max(max(owners, default=-1), max(neighbours, default=-1))
    if not 0 < cells <= MAX_CELLS or cells != expected_cells or len(neighbours) >= len(owners):
        raise ValueError("저장 결과와 OpenFOAM 격자의 셀 수가 일치하지 않습니다.")
    points = [tuple(coordinate * 1000 for coordinate in point) for point in cfd_case.mesh_points(mesh)]
    bounds = [min(axis) for axis in zip(*points)] + [max(axis) for axis in zip(*points)]
    if len(bounds) != 6 or any(not math.isfinite(value) for value in bounds):
        raise ValueError("OpenFOAM 격자 범위를 읽을 수 없습니다.")
    faces = list(cfd_case.mesh_faces(mesh, len(owners), len(points)))
    patches = cfd_case.boundary_patches(mesh / "boundary")
    coverage = sorted((start, start + size) for start, size in patches.values() if size)
    if (not coverage or coverage[0][0] != len(neighbours) or coverage[-1][1] != len(owners)
            or any(first[1] != second[0] for first, second in zip(coverage, coverage[1:]))):
        raise ValueError("OpenFOAM 외곽 격자 면이 경계 패치와 일치하지 않습니다.")
    fields, boundaries = {}, {}
    for field in FIELDS:
        fields[field], boundaries[field] = read_field(time, field, cells, rho, patches, owners)
    return SolvedMesh(points, bounds, faces, owners, neighbours, patches, fields, boundaries)


def surface_samples(mesh, field):
    samples = PreviewSample(SURFACE_LIMIT)
    for name, values in mesh.boundaries[field].items():
        start, _ = mesh.patches[name]
        for face, value in zip(mesh.faces[start:start + len(values)], values):
            samples.append(([(node, mesh.points[node]) for node in face], value))
    return samples


def cell_faces(mesh, count):
    by_cell = [[] for _ in range(count)]
    for index, cell in enumerate(mesh.owners):
        by_cell[cell].append(mesh.faces[index])
    for index, cell in enumerate(mesh.neighbours):
        by_cell[cell].append(mesh.faces[index])
    return by_cell


def cell_edges(faces):
    indices, edges = {}, set()
    for face in faces:
        for node in face:
            indices.setdefault(node, len(indices))
        for a, b in zip(face, (*face[1:], face[0])):
            edges.add(tuple(sorted((indices[a], indices[b]))))
    return tuple(indices), sorted(edges)


def section_samples(mesh, field, axis, position):
    samples = PreviewSample(SECTION_LIMIT)
    values = mesh.fields[field]
    delta = mesh.bounds[axis + 3] - mesh.bounds[axis]
    epsilon = max(delta * 1e-12, math.ulp(position) * 8)
    offsets = [point[axis] - position for point in mesh.points]
    offsets = [offset if abs(offset) > epsilon else 0 for offset in offsets]
    coplanar = set()
    for faces, value in zip(cell_faces(mesh, len(values)), values):
        nodes = {node for face in faces for node in face}
        if not nodes or min(offsets[node] for node in nodes) > 0 or max(offsets[node] for node in nodes) < 0:
            continue
        nodes, edges = cell_edges(faces)
        polygon = cut_polygon(nodes, edges, mesh.points, offsets, axis, position, epsilon)
        if polygon is None:
            continue
        if all(key[0] == key[1] for key, _ in polygon):
            face = tuple(sorted(key[0] for key, _ in polygon))
            if face in coplanar:
                continue
            coplanar.add(face)
        samples.append((polygon, value))
    return samples


def clip_height(polygon, z, above):
    result = []
    for start, end in zip(polygon[-1:]+polygon[:-1], polygon):
        a, b = start[1]-z, end[1]-z
        if (a > 0) != (b > 0):
            result.append((start[0]+(end[0]-start[0])*a/(a-b), z))
        if (b >= 0 if above else b <= 0):
            result.append(end)
    return result


@lru_cache(maxsize=48)
def middle_profile(case, instant, rho, cells):
    mesh = load(case,instant,rho,cells)
    samples = section_samples(mesh,"speed",0,(mesh.bounds[0]+mesh.bounds[3])/2)
    if samples.truncated:
        raise ValueError("해당 단면은 비교 표본 한도를 초과합니다.")
    z0,z1 = mesh.bounds[2],mesh.bounds[5]
    edges = [z0+(z1-z0)*i/8 for i in range(9)]
    totals, weights = [0.0]*8,[0.0]*8
    for polygon,value in samples.items:
        yz = [(point[1],point[2]) for _,point in polygon]
        for i in range(8):
            piece = clip_height(clip_height(yz,edges[i],True),edges[i+1],False)
            if len(piece)<3: continue
            area = abs(sum(a*d-b*c for (a,b),(c,d) in zip(piece,piece[1:]+piece[:1])))/2
            totals[i] += area*value
            weights[i] += area
    return [total/weight if weight else None for total,weight in zip(totals,weights)]


def preview(mesh, field, axis=None, fraction=0.5):
    position = None
    if axis is None:
        samples = surface_samples(mesh, field)
    else:
        index = "xyz".index(axis)
        low, high = mesh.bounds[index], mesh.bounds[index + 3]
        position = low + fraction * (high - low)
        samples = section_samples(mesh, field, index, position)
    points, indices, polygons, values = [], {}, [], []
    for polygon, value in samples.items:
        ids = []
        for key, point in polygon:
            if key not in indices:
                indices[key] = len(points)
                points.append(point)
            ids.append(indices[key])
        polygons.append(ids)
        values.append(value)
    scale = [mesh.fields[field], *mesh.boundaries[field].values()]
    return {
        "bounds_mm": mesh.bounds, "points_mm": points, "polygons": polygons, "values": values,
        "minimum": min(map(min, scale)), "maximum": max(map(max, scale)), "unit": FIELDS[field][2],
        "position_mm": position, "count": samples.count, "truncated": samples.truncated,
    }
