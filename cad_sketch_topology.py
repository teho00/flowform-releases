"""Split planar sketch curves and follow their bounded face perimeters."""

from collections import defaultdict
from dataclasses import dataclass, field
from itertools import combinations, product
from math import atan2, cos, floor, hypot, sin, tau

from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire
from OCP.Geom2d import Geom2d_Circle, Geom2d_Ellipse, Geom2d_Line, Geom2d_TrimmedCurve
from OCP.Geom2dAPI import Geom2dAPI_InterCurveCurve
from OCP.TopoDS import TopoDS
from OCP.gp import gp_Ax2, gp_Ax2d, gp_Circ, gp_Dir, gp_Dir2d, gp_Elips, gp_Pnt2d


TOLERANCE = 1e-7
MAX_SEGMENTS = 8192
NEIGHBOR_BUCKETS = tuple(product((-1, 0, 1), repeat=2))


@dataclass
class Curve:
    entity_id: str
    kind: str
    origin: tuple
    dx: float
    dy: float
    start: float = 0.0
    sweep: float = tau
    breaks: list = field(default_factory=list)

    def angle(self, t):
        return self.start + t * self.sweep

    def point(self, t):
        x, y = self.origin
        if self.kind == "line":
            return (x + t * self.dx, y + t * self.dy)
        angle = self.angle(t)
        return (x + self.dx * cos(angle), y + self.dy * sin(angle))

    def parameter(self, point):
        for end in (0.0, 1.0):
            if distance(self.point(end), point) <= TOLERANCE:
                return end
        x, y = (value - origin for value, origin in zip(point, self.origin))
        if self.kind == "line":
            t = (x * self.dx + y * self.dy) / (self.dx ** 2 + self.dy ** 2)
        else:
            angle = atan2(y / self.dy, x / self.dx)
            turn = (angle - self.start) % tau if self.sweep > 0 else (self.start - angle) % tau
            t = turn / abs(self.sweep)
        if 0 < t < 1 and distance(self.point(t), point) <= TOLERANCE:
            return t
        return None

    def bounds(self, first=0.0, last=1.0):
        points = [self.point(first), self.point(last)]
        if self.kind != "line":
            left, right = sorted((self.angle(first), self.angle(last)))
            quarter = tau / 4
            for index in range(floor(left / quarter) + 1, floor(right / quarter) + 1):
                t = (index * quarter - self.start) / self.sweep
                points.append(self.point(t))
        xs, ys = zip(*points)
        return min(xs), min(ys), max(xs), max(ys)

    def intersection_curve(self):
        x, y = self.origin
        origin = gp_Pnt2d(x, y)
        if self.kind == "line":
            line = Geom2d_Line(origin, gp_Dir2d(self.dx, self.dy))
            return Geom2d_TrimmedCurve(line, 0.0, hypot(self.dx, self.dy))
        ellipse = self.dx != self.dy
        turn = tau / 4 if self.dy > self.dx else 0.0
        axis = gp_Ax2d(origin, gp_Dir2d(0, 1) if turn else gp_Dir2d(1, 0))
        conic = (Geom2d_Ellipse(axis, max(self.dx, self.dy), min(self.dx, self.dy))
                 if ellipse else Geom2d_Circle(axis, self.dx))
        if abs(self.sweep) == tau:
            return conic
        start, end = sorted((self.start - turn, self.start + self.sweep - turn))
        return Geom2d_TrimmedCurve(conic, start, end)

    def edge(self, plane, first, last):
        if self.kind == "line":
            return BRepBuilderAPI_MakeEdge(plane.point(*self.point(first)), plane.point(*self.point(last))).Edge()
        turn = tau / 4 if self.dy > self.dx else 0.0
        axes = gp_Ax2(plane.point(*self.origin), gp_Dir(*plane.normal), gp_Dir(*(plane.y if turn else plane.x)))
        conic = (gp_Circ(axes, self.dx) if self.dx == self.dy
                 else gp_Elips(axes, max(self.dx, self.dy), min(self.dx, self.dy)))
        start, end = self.angle(first) - turn, self.angle(last) - turn
        if abs(abs(end - start) - tau) <= 1e-12:
            edge = BRepBuilderAPI_MakeEdge(conic).Edge()
        else:
            edge = BRepBuilderAPI_MakeEdge(conic, min(start, end), max(start, end)).Edge()
        return TopoDS.Edge_s(edge.Reversed()) if end < start else edge

    def display(self, first, last):
        if self.kind == "line":
            (x1, y1), (x2, y2) = self.point(first), self.point(last)
            return {"kind": "line", "x1": x1, "y1": y1, "x2": x2, "y2": y2}
        x, y = self.origin
        fields = {"x": x, "y": y}
        if self.kind in ("circle", "arc"):
            fields["radius"] = self.dx
        else:
            fields.update(rx=self.dx, ry=self.dy)
        if abs(last - first - 1) <= 1e-12 and self.kind in ("circle", "ellipse"):
            return {"kind": self.kind, **fields}
        return {"kind": "arc" if "radius" in fields else "ellipseArc", **fields,
                "startAngle": self.angle(first), "sweep": self.sweep * (last - first)}

    def double_area(self, first, last, origin):
        (ax, ay), (bx, by) = self.point(first), self.point(last)
        ox, oy = origin
        if self.kind == "line":
            return (ax - ox) * (by - oy) - (bx - ox) * (ay - oy)
        x, y = self.origin
        return self.dx * self.dy * self.sweep * (last - first) + (x - ox) * (by - ay) - (y - oy) * (bx - ax)


def distance(first, second):
    return hypot(first[0] - second[0], first[1] - second[1])


def line(entity_id, start, end):
    return Curve(entity_id, "line", start, end[0] - start[0], end[1] - start[1])


def curves_for(entity):
    key, kind = entity["id"], entity["kind"]
    if kind == "line":
        return [line(key, (entity["x1"], entity["y1"]), (entity["x2"], entity["y2"]))]
    if kind == "point":
        return []
    origin = entity["x"], entity["y"]
    if kind == "rectangle":
        x, y = origin
        width, length = entity["width"], entity["length"]
        corners = [(x, y), (x + width, y), (x + width, y + length), (x, y + length)]
        return [line(key, point, corners[(index + 1) % 4]) for index, point in enumerate(corners)]
    if kind in ("circle", "arc"):
        return [Curve(key, kind, origin, entity["radius"], entity["radius"],
                      entity.get("startAngle", 0.0), entity.get("sweep", tau))]
    return [Curve(key, kind, origin, entity["rx"], entity["ry"],
                  entity.get("startAngle", 0.0), entity.get("sweep", tau))]


def add_intersection(first, second, point):
    a, b = first.parameter(point), second.parameter(point)
    if a is not None and b is not None:
        first.breaks.append(a)
        second.breaks.append(b)


def find_breaks(curves):
    candidates = sorted(((curve.bounds(), index, curve) for index, curve in enumerate(curves)),
                        key=lambda item: item[0][0])
    geometry = {}
    for position, ((_, bottom, right, top), index, first) in enumerate(candidates):
        for (left, lower, _, upper), other_index, second in candidates[position + 1:]:
            if left > right + TOLERANCE:
                break
            if min(top, upper) + TOLERANCE < max(bottom, lower) or first.entity_id == second.entity_id:
                continue
            # The intersection solver returns coincident intervals separately.
            # Their boundaries are always endpoints of at least one input curve.
            for curve in (first, second):
                for endpoint in (0.0, 1.0):
                    add_intersection(first, second, curve.point(endpoint))
            if index not in geometry:
                geometry[index] = first.intersection_curve()
            if other_index not in geometry:
                geometry[other_index] = second.intersection_curve()
            intersections = Geom2dAPI_InterCurveCurve(geometry[index], geometry[other_index], TOLERANCE)
            for occurrence in range(1, intersections.NbPoints() + 1):
                point = intersections.Point(occurrence)
                add_intersection(first, second, (point.X(), point.Y()))


@dataclass
class Segment:
    curve: Curve
    first: float
    last: float
    start: tuple
    end: tuple
    ordinal: int

    def range(self, reversed_edge):
        return (self.last, self.first) if reversed_edge else (self.first, self.last)

    def angle(self, reversed_edge):
        first, last = self.range(reversed_edge)
        a = self.curve.point(first)
        b = self.curve.point(first + (last - first) * 1e-5)
        return atan2(b[1] - a[1], b[0] - a[0]) % tau


def curve_intervals(curve):
    if curve.kind in ("circle", "ellipse"):
        # A full conic has no sketch endpoint at the kernel's parameter seam.
        # Start at a real intersection so Trim can remove a complete segment.
        keys = sorted({value % 1 for value in curve.breaks}) or [0.0]
        return [*keys, keys[0] + 1]
    return sorted({0.0, 1.0, *curve.breaks})


def split_curves(curves):
    find_breaks(curves)
    buckets = defaultdict(list)
    pieces, graph, seen = [], [], set()
    ordinals = defaultdict(int)

    def vertex(point):
        u, v = (floor(value / TOLERANCE) for value in point)
        for a, b in NEIGHBOR_BUCKETS:
            for known in buckets[u + a, v + b]:
                if distance(known, point) <= TOLERANCE:
                    return known
        buckets[u, v].append(point)
        return point

    for curve in curves:
        first, *remaining = curve_intervals(curve)
        for last in remaining:
            start, end = vertex(curve.point(first)), vertex(curve.point(last))
            full_circle = curve.kind != "line" and abs(curve.sweep * (last - first)) >= tau - 1e-10
            if start == end and not full_circle:
                continue
            ordinal = ordinals[curve.entity_id]
            ordinals[curve.entity_id] += 1
            segment = Segment(curve, first, last, start, end, ordinal)
            pieces.append({"entityId": curve.entity_id, "curve": curve.display(first, last)})
            key = [min(start, end), max(start, end)]
            if curve.kind != "line":
                key.append(vertex(curve.point((first + last) / 2)))
            signature = tuple(key)
            if signature not in seen:
                graph.append(segment)
                seen.add(signature)
            first = last
            if len(pieces) > MAX_SEGMENTS:
                raise ValueError("교차한 스케치 구간이 너무 많습니다.")
    return pieces, graph


def graph_bridges(adjacency, segments):
    """Find edges with no alternate path between their endpoints."""
    visited, low, result = {}, {}, set()
    for start in adjacency:
        if start in visited:
            continue
        visited[start] = low[start] = len(visited)
        stack = [(start, None, iter(adjacency[start]))]
        while stack:
            point, parent_edge, edges = stack[-1]
            edge, reverse = next(edges, (None, None))
            if edge is None:
                stack.pop()
                if stack:
                    parent = stack[-1][0]
                    low[parent] = min(low[parent], low[point])
                    if low[point] > visited[parent]:
                        result.add(parent_edge)
                continue
            if edge == parent_edge:
                continue
            segment = segments[edge]
            other = segment.start if reverse else segment.end
            if other in visited:
                low[point] = min(low[point], visited[other])
                continue
            visited[other] = low[other] = len(visited)
            stack.append((other, edge, iter(adjacency[other])))
    return result


def bounded_paths(segments):
    adjacency = defaultdict(list)
    for index, segment in enumerate(segments):
        adjacency[segment.start].append((index, False))
        adjacency[segment.end].append((index, True))
    open_points = [point for point, edges in adjacency.items() if len(edges) == 1]
    bridges = graph_bridges(adjacency, segments)
    successors = {}
    for edges in adjacency.values():
        ordered = sorted((edge for edge in edges if edge[0] not in bridges),
                         key=lambda edge: segments[edge[0]].angle(edge[1]))
        for position, (index, reverse) in enumerate(ordered):
            successors[index, not reverse] = ordered[position - 1]

    visited = set()
    paths = []
    for seed in successors:
        if seed in visited:
            continue
        edges, path, halfedge = set(), [], seed
        while halfedge not in visited:
            visited.add(halfedge)
            index, reverse = halfedge
            edges.add(index)
            path.append((segments[index], reverse))
            halfedge = successors[halfedge]
        if len(edges) == len(path):
            paths.append(path)
    return paths, open_points


def path_wire(plane, path):
    first, reversed_edge = path[0]
    origin = first.end if reversed_edge else first.start
    area = sum(segment.curve.double_area(*segment.range(reversed_edge), origin)
               for segment, reversed_edge in path) / 2
    if area <= TOLERANCE ** 2:
        return None
    maker = BRepBuilderAPI_MakeWire()
    bounds = []
    for segment, reverse in path:
        maker.Add(segment.curve.edge(plane, *segment.range(reverse)))
        if not maker.IsDone():
            return None
        bounds.append(segment.curve.bounds(segment.first, segment.last))
    left, bottom, right, top = zip(*bounds)
    return (maker.Wire(), (min(left), min(bottom), max(right), max(top)), plane.point(*origin), area)
