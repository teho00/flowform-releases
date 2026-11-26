"""Validate planar sketch entities and turn closed contours into exact OCCT faces."""

from collections import defaultdict, deque
from dataclasses import dataclass
from hashlib import sha256
from itertools import product
from math import floor, hypot, isfinite, pi, tau
from re import fullmatch

from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_MakeWire,
)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Ax2, gp_Ax3, gp_Circ, gp_Dir, gp_Elips, gp_Pln, gp_Pnt
from OCP.TopAbs import TopAbs_FACE, TopAbs_IN
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Face, TopoDS_Wire

from cad_sketch_topology import TOLERANCE, bounded_paths, curves_for, path_wire, split_curves


MAX_COORDINATE = 1_000_000.0
MIN_DIMENSION = 0.0001
MAX_ENTITIES = 256
MIN_OVERLAP_AREA = TOLERANCE ** 2
XY_PLANE = {"origin": [0.0, 0.0, 0.0], "x": [1.0, 0.0, 0.0], "y": [0.0, 1.0, 0.0]}
ENTITY_FIELDS = {
    "point": ("x", "y"),
    "line": ("x1", "y1", "x2", "y2"),
    "rectangle": ("x", "y", "width", "length"),
    "circle": ("x", "y", "radius"),
    "ellipse": ("x", "y", "rx", "ry"),
    "arc": ("x", "y", "radius", "startAngle", "sweep"),
    "ellipseArc": ("x", "y", "rx", "ry", "startAngle", "sweep"),
}
DIMENSIONS = {"width", "length", "radius", "rx", "ry"}
NEIGHBOR_BUCKETS = tuple(product((-1, 0, 1), repeat=2))


def identifier(value, label):
    if not isinstance(value, str) or not fullmatch(r"[A-Za-z0-9_.:-]{1,64}", value):
        raise ValueError(f"{label} 식별자가 올바르지 않습니다.")
    return value


def real_number(value, label):
    if type(value) not in (int, float) or abs(value) > MAX_COORDINATE or not isfinite(value):
        raise ValueError(f"{label}에 유효한 숫자를 입력하세요.")
    return float(value)


def coordinates(value):
    return [value.X(), value.Y(), value.Z()]


def vector(value, label):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"{label}에는 좌표 세 개가 필요합니다.")
    return [real_number(component, label) for component in value]


@dataclass
class SketchPlane:
    origin: list
    x: list
    y: list
    normal: list

    @classmethod
    def from_input(cls, data):
        if not isinstance(data, dict):
            raise ValueError("스케치 평면을 입력하세요.")
        origin = vector(data.get("origin"), "평면 원점")
        x = vector(data.get("x"), "평면 X 방향")
        y = vector(data.get("y"), "평면 Y 방향")
        if abs(hypot(*x) - 1) > 1e-6 or abs(hypot(*y) - 1) > 1e-6:
            raise ValueError("스케치 평면의 축은 단위 벡터여야 합니다.")
        x_axis, y_axis = gp_Dir(*x), gp_Dir(*y)
        if abs(x_axis.Dot(y_axis)) > 1e-6:
            raise ValueError("스케치 평면의 두 축은 직각이어야 합니다.")
        normal = x_axis.Crossed(y_axis)
        return cls(origin, coordinates(x_axis), coordinates(normal.Crossed(x_axis)), coordinates(normal))

    def data(self):
        return {"origin": self.origin, "x": self.x, "y": self.y}

    def point(self, u, v):
        xyz = [origin + u * x + v * y for origin, x, y in zip(self.origin, self.x, self.y)]
        if any(not isfinite(value) or abs(value) > MAX_COORDINATE for value in xyz):
            raise ValueError("스케치가 작업 범위 ±1,000,000 mm를 벗어났습니다.")
        return gp_Pnt(*xyz)

    def surface(self):
        return gp_Pln(gp_Ax3(gp_Pnt(*self.origin), gp_Dir(*self.normal), gp_Dir(*self.x)))


@dataclass
class Contour:
    id: str
    entity_ids: list
    wire: TopoDS_Wire
    bounds: tuple
    sample: gp_Pnt
    face: TopoDS_Face
    area: float
    segmented: bool = False


@dataclass
class Sketch:
    id: str
    plane: SketchPlane
    entities: list
    contours: list
    regions: dict
    overlap_groups: list
    hidden_entity_ids: list
    aliases: dict
    legacy_regions: dict
    segments: list
    open_points: list

    def region(self, region_id):
        key = self.aliases.get(region_id, region_id)
        return self.regions.get(key) or self.legacy_regions.get(key)


@dataclass
class Region:
    id: str
    entity_ids: list
    face: TopoDS_Face
    merged: bool = False
    segmented: bool = False


def build_sketch(operation):
    sketch_id = identifier(operation.get("id"), "스케치")
    plane = SketchPlane.from_input(operation.get("plane", XY_PLANE))
    raw_entities = operation.get("entities")
    if not isinstance(raw_entities, list) or len(raw_entities) > MAX_ENTITIES:
        raise ValueError(f"스케치 하나에 최대 {MAX_ENTITIES}개의 요소를 저장할 수 있습니다.")

    entities = []
    seen = set()
    for raw in raw_entities:
        if not isinstance(raw, dict):
            raise ValueError("잘못된 스케치 요소입니다.")
        entity_id = identifier(raw.get("id"), "스케치 요소")
        if entity_id in seen:
            raise ValueError("스케치 요소 식별자가 중복됩니다.")
        seen.add(entity_id)
        kind = raw.get("kind")
        if not isinstance(kind, str) or kind not in ENTITY_FIELDS:
            raise ValueError("지원하지 않는 스케치 도형입니다.")
        entity = {"id": entity_id, "kind": kind}
        for field in ENTITY_FIELDS[kind]:
            value = real_number(raw.get(field), field)
            if field in DIMENSIONS and value < MIN_DIMENSION:
                raise ValueError(f"{field}는 {MIN_DIMENSION:g} mm 이상이어야 합니다.")
            entity[field] = value
        if "construction" in raw and type(raw["construction"]) is not bool:
            raise ValueError("보조선 설정은 참 또는 거짓이어야 합니다.")
        if raw.get("construction"):
            entity["construction"] = True
        if kind == "line":
            if hypot(entity["x2"] - entity["x1"], entity["y2"] - entity["y1"]) < MIN_DIMENSION:
                raise ValueError(f"선 길이는 {MIN_DIMENSION:g} mm 이상이어야 합니다.")
            plane.point(entity["x1"], entity["y1"])
            plane.point(entity["x2"], entity["y2"])
        else:
            plane.point(entity["x"], entity["y"])
        if kind in ("arc", "ellipseArc"):
            entity["startAngle"] %= tau
            sweep = abs(entity["sweep"])
            radius = entity.get("radius") or max(entity["rx"], entity["ry"])
            if not 0 < sweep < tau or radius * sweep < MIN_DIMENSION:
                raise ValueError("원을 그리려면 원 도구를 사용하세요. 호의 길이는 0.0001 mm 이상이어야 합니다.")
            left, bottom, right, top = curves_for(entity)[0].bounds()
            for corner in ((left, bottom), (left, top), (right, bottom), (right, top)):
                plane.point(*corner)
        entities.append(entity)

    active_entities = [entity for entity in entities if not entity.get("construction")]
    originals = []
    for entity in active_entities:
        kind = entity["kind"]
        if kind == "rectangle":
            x, y, width, length = (entity[field] for field in ("x", "y", "width", "length"))
            vertices = [(x, y), (x + width, y), (x + width, y + length), (x, y + length)]
            originals.append(polygon_contour(plane, [entity["id"]], vertices))
        elif kind in ("circle", "ellipse"):
            originals.append(conic_contour(plane, entity))
    for ids, vertices in closed_line_loops(active_entities):
        originals.append(polygon_contour(plane, ids, vertices))
    originals = [item for item in originals if item is not None]
    legacy_regions = make_regions(plane, originals)
    overlaps = overlap_groups(legacy_regions, {contour.id: contour.bounds for contour in originals})

    curves = [curve for entity in active_entities for curve in curves_for(entity)]
    segments, graph = split_curves(curves)
    paths, open_points = bounded_paths(graph)
    arranged, profiles = arrange(plane, paths, originals)
    regions = make_regions(plane, arranged)

    contours = [*originals, *profiles]
    entity_order = {entity["id"]: index for index, entity in enumerate(entities)}
    contours.sort(key=lambda contour: min(entity_order[key] for key in contour.entity_ids))
    merge_ids = operation.get("mergeRegions", [])
    if not isinstance(merge_ids, list) or len(merge_ids) > MAX_ENTITIES:
        raise ValueError("합칠 스케치 영역을 다시 선택하세요.")
    merge_ids = {identifier(value, "합칠 스케치 영역") for value in merge_ids}
    hidden, aliases = merge_regions(legacy_regions, overlaps, merge_ids)
    merged = [region for region in legacy_regions.values() if region.merged]
    if merged:
        regions = {key: region for key, region in regions.items()
                   if not any(not set(group.entity_ids).isdisjoint(region.entity_ids)
                              and faces_overlap(group.face, region.face) for group in merged)}
        regions.update((region.id, region) for region in merged)
    return Sketch(sketch_id, plane, entities, contours, regions, overlaps, sorted(hidden), aliases,
                  legacy_regions, segments, open_points)


def arrange(plane, paths, originals):
    original_by_ids = {frozenset(contour.entity_ids): contour for contour in originals}
    part_count = defaultdict(int)
    iterations = []
    for path in paths:
        result = path_wire(plane, path)
        if result is None:
            continue
        ids = sorted({segment.curve.entity_id for segment, _ in path})
        iterations.append((path, ids, result))
        for key in ids:
            part_count[key] += 1

    original_ids = {key for contour in originals for key in contour.entity_ids}
    arranged, profiles = [], []
    for path, ids, (wire, bounds, sample, area) in iterations:
        original = original_by_ids.get(frozenset(ids))
        if original and abs(area - original.area) <= max(1e-12, area * 1e-9):
            arranged.append(original)
            continue
        steps = [(segment.curve.entity_id, segment.ordinal, reverse) for segment, reverse in path]
        pivot = steps.index(min(steps))
        fingerprint = sha256(repr(steps[pivot:] + steps[:pivot]).encode()).hexdigest()[:24]
        contour = outline(plane, ids, wire, bounds, sample, area,
                          region_id="region-" + fingerprint, segmented=True)
        if contour is not None:
            arranged.append(contour)
            # A face bounded by split pieces only exists in 3D. In 2D it would
            # pick shared source entities and move portions outside the face.
            if original_ids.isdisjoint(ids) and all(part_count[key] == 1 for key in ids) and all(
                segment.first == 0 and segment.last == 1 for segment, _ in path
            ):
                profiles.append(contour)
    return arranged, profiles


def closed_line_loops(entities):
    # Endpoint snapping in the editor uses identical coordinates. A tolerance also
    # connects lines entered numerically or reopened with small rounding differences.
    adjacency = defaultdict(set)
    buckets = defaultdict(list)
    endpoints = {}

    def connect_vertex(point):
        x, y = (floor(value / TOLERANCE) for value in point)
        for dx, dy in NEIGHBOR_BUCKETS:
            for candidate in buckets.get((x + dx, y + dy), ()):
                if hypot(candidate[0] - point[0], candidate[1] - point[1]) <= TOLERANCE:
                    return candidate
        buckets[x, y].append(point)
        return point

    for entity in entities:
        if entity["kind"] != "line":
            continue
        start = connect_vertex((entity["x1"], entity["y1"]))
        end = connect_vertex((entity["x2"], entity["y2"]))
        edge = entity["id"]
        endpoints[edge] = (start, end)
        adjacency[start].add(edge)
        adjacency[end].add(edge)

    leaves = deque(point for point, edges in adjacency.items() if len(edges) == 1)
    while leaves:
        point = leaves.popleft()
        if len(adjacency[point]) != 1:
            continue
        edge = adjacency[point].pop()
        start, end = endpoints[edge]
        other = end if start == point else start
        adjacency[other].remove(edge)
        if len(adjacency[other]) == 1:
            leaves.append(other)

    pending = {edge for edges in adjacency.values() for edge in edges}
    while pending:
        seed = min(pending)
        pending.remove(seed)
        queue = [seed]
        component = {seed}
        while queue:
            for point in endpoints[queue.pop()]:
                for edge in adjacency[point] & pending:
                    pending.remove(edge)
                    component.add(edge)
                    queue.append(edge)
        vertices = {point for edge in component for point in endpoints[edge]}
        if len(vertices) < 3 or any(len(adjacency[point]) != 2 for point in vertices):
            continue
        start, current = endpoints[seed]
        ordered = [start]
        previous = seed
        while current != start:
            ordered.append(current)
            edge, = adjacency[current] - {previous}
            a, b = endpoints[edge]
            current = b if current == a else a
            previous = edge
        yield sorted(component), ordered


def polygon_contour(plane, ids, vertices):
    # Subtract the first point before taking products to keep area stable for
    # small profiles placed far from the sketch origin.
    x0, y0 = vertices[0]
    relative = [(x - x0, y - y0) for x, y in vertices]
    signed_area = sum(x * v - y * u for (x, y), (u, v) in zip(relative, relative[1:] + relative[:1])) / 2
    if abs(signed_area) < MIN_DIMENSION ** 2 / 2:
        return None
    if signed_area < 0:
        vertices = list(reversed(vertices))
    polygon = BRepBuilderAPI_MakePolygon()
    for point in vertices:
        polygon.Add(plane.point(*point))
    polygon.Close()
    xs, ys = zip(*vertices)
    bounds = (min(xs), min(ys), max(xs), max(ys))
    return outline(plane, ids, polygon.Wire(), bounds, plane.point(*vertices[0]), abs(signed_area))


def conic_contour(plane, entity):
    x, y = entity["x"], entity["y"]
    kind = entity["kind"]
    rx = entity["radius"] if kind == "circle" else entity["rx"]
    ry = entity["radius"] if kind == "circle" else entity["ry"]
    major_axis = plane.x if rx >= ry else plane.y
    axes = gp_Ax2(plane.point(x, y), gp_Dir(*plane.normal), gp_Dir(*major_axis))
    conic = gp_Circ(axes, rx) if kind == "circle" or rx == ry else gp_Elips(axes, max(rx, ry), min(rx, ry))
    wire = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(conic).Edge()).Wire()
    bounds = (x - rx, y - ry, x + rx, y + ry)
    # Bound the transformed curve even when no pull operation uses this sketch.
    center = coordinates(axes.Location())
    if any(abs(origin) + hypot(u * rx, v * ry) > MAX_COORDINATE
           for origin, u, v in zip(center, plane.x, plane.y)):
        raise ValueError("스케치가 작업 범위 ±1,000,000 mm를 벗어났습니다.")
    return outline(plane, [entity["id"]], wire, bounds, plane.point(x + rx, y), pi * rx * ry)


def outline(plane, ids, wire, bounds, sample, area, *, region_id=None, segmented=False):
    maker = BRepBuilderAPI_MakeFace(plane.surface(), wire, True)
    if not maker.IsDone() or not BRepCheck_Analyzer(maker.Face()).IsValid():
        return None
    return Contour(region_id or ids[0], ids, wire, bounds, sample, maker.Face(), area, segmented)


def contains(outer, inner):
    a, b, c, d = outer.bounds
    x, y, u, v = inner.bounds
    if not (a < x and b < y and u < c and v < d):
        return False
    if BRepClass_FaceClassifier(outer.face, inner.sample, TOLERANCE).State() != TopAbs_IN:
        return False
    distance = BRepExtrema_DistShapeShape(outer.wire, inner.wire)
    return distance.IsDone() and distance.Value() > TOLERANCE


def make_regions(plane, contours):
    children = defaultdict(list)
    ordered = sorted(contours, key=lambda contour: (contour.area, contour.id))
    for index, child in enumerate(ordered):
        parent = next((candidate for candidate in ordered[index + 1:] if contains(candidate, child)), None)
        if parent is not None:
            children[parent.id].append(child)

    regions = {}
    for contour in ordered:
        holes = children[contour.id]
        if not holes:
            regions[contour.id] = Region(contour.id, contour.entity_ids, contour.face, segmented=contour.segmented)
            continue
        maker = BRepBuilderAPI_MakeFace(plane.surface(), contour.wire, True)
        for hole in holes:
            maker.Add(TopoDS.Wire_s(hole.wire.Reversed()))
        face = maker.Face()
        if BRepCheck_Analyzer(face).IsValid():
            entity_ids = contour.entity_ids + [entity for hole in holes for entity in hole.entity_ids]
            regions[contour.id] = Region(contour.id, entity_ids, face,
                                         segmented=contour.segmented or any(hole.segmented for hole in holes))
    return regions


def overlap_groups(regions, bounds):
    """Find connected groups sharing positive area, leaving nested holes alone."""
    ordered = sorted(regions, key=lambda key: (bounds[key][0], key))
    parents = {key: key for key in ordered}

    def group_root(key):
        while key != parents[key]:
            parents[key] = parents[parents[key]]
            key = parents[key]
        return key

    for index, first in enumerate(ordered):
        _, bottom, right, top = bounds[first]
        for second in ordered[index + 1:]:
            left, other_bottom, _, other_top = bounds[second]
            if left >= right:
                break
            if max(bottom, other_bottom) >= min(top, other_top):
                continue
            first_root, second_root = group_root(first), group_root(second)
            if first_root == second_root:
                continue
            if faces_overlap(regions[first].face, regions[second].face):
                parents[second_root] = first_root

    groups = defaultdict(list)
    for key in sorted(ordered):
        groups[group_root(key)].append(key)
    return sorted(group for group in groups.values() if len(group) > 1)


def faces_overlap(first, second):
    common = BRepAlgoAPI_Common(first, second)
    if not common.IsDone():
        raise ValueError("두 스케치 윤곽의 겹침을 확인하지 못했습니다.")
    shape = common.Shape()
    if shape.IsNull():
        return False
    properties = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, properties)
    return properties.Mass() > MIN_OVERLAP_AREA


def merged_face(faces):
    combined = faces[0]
    for face in faces[1:]:
        fuse = BRepAlgoAPI_Fuse(combined, face)
        if not fuse.IsDone():
            raise ValueError("겹친 스케치 윤곽을 합치지 못했습니다.")
        fuse.SimplifyResult()
        combined = fuse.Shape()
    explorer = TopExp_Explorer(combined, TopAbs_FACE)
    if not explorer.More():
        raise ValueError("합친 스케치에서 닫힌 영역을 만들지 못했습니다.")
    face = TopoDS.Face_s(explorer.Current())
    explorer.Next()
    if explorer.More() or not BRepCheck_Analyzer(face).IsValid():
        raise ValueError("겹친 윤곽을 하나의 유효한 스케치 영역으로 만들지 못했습니다.")
    return face


def merge_regions(regions, overlaps, requested):
    hidden, aliases = set(), {}
    for group in overlaps:
        if requested.isdisjoint(group):
            continue
        inputs = [regions.pop(key) for key in group]
        region_id = group[0]
        for key in group:
            aliases[key] = region_id
        entities = sorted({entity for region in inputs for entity in region.entity_ids})
        hidden.update(entities)
        regions[region_id] = Region(region_id, entities, merged_face([region.face for region in inputs]), merged=True)
    return hidden, aliases
