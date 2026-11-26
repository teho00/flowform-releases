"""Read boundary polygons and cell cross-sections from a saved Gmsh mesh."""

import math
from itertools import combinations
from pathlib import Path

from cfd_mesh import MAX_CELLS


PATCH_NAMES = ("inlet", "outlet", "walls")
PATCH_LIMITS = {"inlet": 8_000, "outlet": 8_000, "walls": 40_000}
SECTION_LIMIT = 30_000
TET_EDGES = tuple(combinations(range(4), 2))
HEX_EDGES = (
    (0, 1), (1, 2), (2, 3), (3, 0), (4, 5), (5, 6), (6, 7), (7, 4),
    (0, 4), (1, 5), (2, 6), (3, 7),
)
PRISM_EDGES = ((0, 1), (1, 2), (2, 0), (3, 4), (4, 5), (5, 3), (0, 3), (1, 4), (2, 5))
VOLUME_EDGES = {4: TET_EDGES, 5: HEX_EDGES, 6: PRISM_EDGES}
ELEMENT_SIZES = {2: {2: 3, 3: 4}, 3: {4: 4, 5: 8, 6: 6}}


class PreviewSample:
    """Keep a bounded, evenly spaced subset in source order."""

    def __init__(self, limit):
        self.limit = limit
        self.items = []
        self.count = 0
        self.stride = 1

    def append(self, item):
        if self.count % self.stride == 0:
            self.items.append(item)
            if len(self.items) > self.limit:
                self.stride *= 2
                del self.items[1::2]
        self.count += 1

    @property
    def truncated(self):
        return self.stride > 1


def expect(source, marker):
    if source.readline().strip() != marker:
        raise ValueError(marker)


def read_count(source, limit):
    count = int(source.readline())
    if not 0 < count <= limit:
        raise ValueError("section count")
    return count


def read_groups(source):
    expect(source, "$PhysicalNames")
    groups = {}
    for _ in range(read_count(source, 4)):
        dimension, label, quoted = source.readline().split()
        group = (int(dimension), quoted.strip('"'))
        if int(label) in groups:
            raise ValueError("duplicate group")
        groups[int(label)] = group
    expect(source, "$EndPhysicalNames")
    if set(groups.values()) != {(2, name) for name in PATCH_NAMES} | {(3, "fluid")}:
        raise ValueError("boundary names")
    return groups


def read_points(source):
    expect(source, "$Nodes")
    points = {}
    low, high = [math.inf] * 3, [-math.inf] * 3
    for _ in range(read_count(source, 4 * MAX_CELLS)):
        label, *coordinates = source.readline().split()
        label = int(label)
        point = tuple(1000 * float(value) for value in coordinates)
        if label < 1 or label in points or len(point) != 3 or not all(map(math.isfinite, point)):
            raise ValueError("node coordinates")
        points[label] = point
        for axis, position in enumerate(point):
            low[axis] = min(low[axis], position)
            high[axis] = max(high[axis], position)
    expect(source, "$EndNodes")
    if any(a >= b for a, b in zip(low, high)):
        raise ValueError("mesh bounds")
    return points, low + high


def cut_polygon(nodes, edges, points, offsets, axis, position, epsilon):
    distances = [offsets[label] for label in nodes]
    if min(distances) > 0 or max(distances) < 0:
        return None

    vertices = {}
    for label, distance in zip(nodes, distances):
        if distance == 0:
            point = list(points[label])
            point[axis] = position
            vertices[(label, label)] = point
    for first, second in edges:
        a, b = distances[first], distances[second]
        if not (a < 0 < b or b < 0 < a):
            continue
        first_id, second_id = nodes[first], nodes[second]
        blend = a / (a - b)
        point = [x + (y - x) * blend for x, y in zip(points[first_id], points[second_id])]
        point[axis] = position
        vertices[tuple(sorted((first_id, second_id)))] = point
    if len(vertices) < 3:
        return None

    u, v = (index for index in range(3) if index != axis)
    center_u = math.fsum(point[u] for point in vertices.values()) / len(vertices)
    center_v = math.fsum(point[v] for point in vertices.values()) / len(vertices)
    ordered = sorted(vertices.items(), key=lambda item: math.atan2(item[1][v] - center_v, item[1][u] - center_u))
    local = [(point[u] - center_u, point[v] - center_v) for _, point in ordered]
    area_twice = math.fsum(x * d - y * c for (x, y), (c, d) in zip(local, local[1:] + local[:1]))
    if area_twice <= epsilon * epsilon:
        return None
    return ordered


def read_elements(source, groups, points, bounds, axis, fraction):
    patch_samples = {name: PreviewSample(PATCH_LIMITS[name]) for name in PATCH_NAMES}
    section_sample = PreviewSample(SECTION_LIMIT)
    position = None
    if axis is not None:
        low, high = bounds[axis], bounds[axis + 3]
        position = low + (high - low) * fraction
        epsilon = max((high - low) * 1e-12, math.ulp(position) * 8)
        offsets = {}
        for label, point in points.items():
            distance = point[axis] - position
            offsets[label] = distance if abs(distance) > epsilon else 0

    expect(source, "$Elements")
    coplanar = set()
    cells = {"tetrahedra": 0, "hexahedra": 0}
    for _ in range(read_count(source, 5 * MAX_CELLS)):
        row = [int(value) for value in source.readline().split()]
        label, kind, tag_count = row[:3]
        dimension, name = groups[row[3]]
        nodes = tuple(row[3 + tag_count:])
        if (label < 1 or tag_count < 1 or len(nodes) != ELEMENT_SIZES[dimension].get(kind)
                or len(set(nodes)) != len(nodes) or any(node not in points for node in nodes)):
            raise ValueError("element nodes")
        if dimension == 2:
            patch_samples[name].append(nodes if axis is None else None)
            continue

        key = {4: "tetrahedra", 5: "hexahedra", 6: "prisms"}[kind]
        cells[key] = cells.get(key, 0) + 1
        if axis is None:
            continue
        polygon = cut_polygon(nodes, VOLUME_EDGES[kind], points, offsets, axis, position, epsilon)
        if polygon is None:
            continue
        # Exactly coplanar internal faces are shared by two adjacent cells.
        keys = tuple(sorted(key[0] for key, _ in polygon if key[0] == key[1]))
        if len(keys) == len(polygon):
            if keys in coplanar:
                continue
            coplanar.add(keys)
        section_sample.append(polygon)
    expect(source, "$EndElements")
    if not 0 < sum(cells.values()) <= MAX_CELLS or any(not sample.count for sample in patch_samples.values()):
        raise ValueError("missing boundary or cells")
    return patch_samples, section_sample, position, cells


def compact(points, bounds, patches, section, position, cells):
    point_indices, preview_points = {}, []

    def point_index(key, point):
        if key not in point_indices:
            point_indices[key] = len(preview_points)
            preview_points.append(point)
        return point_indices[key]

    patch_polygons = {
        name: [tuple(point_index(label, points[label]) for label in polygon) for polygon in sample.items]
        if position is None else []
        for name, sample in patches.items()
    }
    section_triangles, section_edges = [], set()
    for polygon in section.items:
        indices = [point_index(key, point) for key, point in polygon]
        section_triangles.extend((indices[0], a, b) for a, b in zip(indices[1:], indices[2:]))
        section_edges.update(tuple(sorted((a, b))) for a, b in zip(indices, indices[1:] + indices[:1]))
    return {
        "bounds_mm": bounds, "points_mm": preview_points, "patches": patch_polygons, "cell_counts": cells,
        "patch_counts": {name: sample.count for name, sample in patches.items()},
        "section": section_triangles, "section_edges": sorted(section_edges), "section_cells": section.count,
        "section_position_mm": position,
        "truncated": any(sample.truncated for sample in patches.values()) if position is None else section.truncated,
    }


def preview(path, axis=None, fraction=0.5):
    """Return indexed boundary polygons and actual cell outlines in millimetres."""
    if axis is not None and axis not in ("x", "y", "z"):
        raise ValueError("단면 축은 X, Y 또는 Z입니다.")
    if type(fraction) not in (int, float) or not 0 <= fraction <= 1:
        raise ValueError("단면 위치는 0부터 1 사이여야 합니다.")
    axis_index = "xyz".index(axis) if axis is not None else None
    try:
        with Path(path).open(encoding="ascii") as source:
            expect(source, "$MeshFormat")
            if source.readline().split() != ["2.2", "0", "8"]:
                raise ValueError("MSH 2.2 ASCII required")
            expect(source, "$EndMeshFormat")
            groups = read_groups(source)
            points, bounds = read_points(source)
            patches, section, position, cells = read_elements(source, groups, points, bounds, axis_index, fraction)
    except (ValueError, KeyError, IndexError, OverflowError) as error:
        raise ValueError("저장된 Gmsh 격자 파일을 읽을 수 없습니다.") from error
    return compact(points, bounds, patches, section, position, cells)
