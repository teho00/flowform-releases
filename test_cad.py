"""Exercise real CAD solids and STEP transfer through the HTTP API."""

import base64
import importlib.util
import json
import math
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from test_app import get_json, running_server


MODEL = "/api/cad/model"
BLOCK = {"type": "extrude", "profile": "rectangle", "x": 0, "y": 0, "z": 0,
         "width": 10, "length": 8, "height": 5}
POCKET = {"type": "cut", "profile": "rectangle", "x": 2, "y": 1, "z": 5,
          "width": 3, "length": 2, "height": 2}
XY = {"origin": [0, 0, 0], "x": [1, 0, 0], "y": [0, 1, 0]}


def document(*operations, domain_cut=None):
    return {"version": 1, "operations": list(operations), "domainCut": domain_cut}


def encode(data):
    return json.dumps(data).encode("utf-8")


def sketch(sketch_id, *entities, plane=XY):
    return {"type": "sketch", "id": sketch_id, "plane": plane, "entities": list(entities)}


def pull(sketch_id, region_id, distance):
    return {"type": "pull", "sketch": sketch_id, "region": region_id, "distance": distance}


@unittest.skipUnless(importlib.util.find_spec("OCP"), "Install requirements-cad.txt for CAD tests")
class CadIntegrationTest(unittest.TestCase):
    def assert_bounds(self, mesh, expected):
        for value, target in zip(mesh["bounds"], expected, strict=True):
            self.assertAlmostEqual(value, target, delta=1e-5)

    def test_solid_edit_and_fluid_volume(self):
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                status, result = get_json(server, "/api/cad/status")
                self.assertEqual(status, 200)
                self.assertTrue(result["ready"], result)
                status, result = get_json(server, MODEL, data=encode(document()))
                self.assertEqual((status, result), (200, {"part": None, "domain": None}))

                move = {"type": "move", "dx": 4, "dy": -1, "dz": -2}
                data = document(BLOCK, POCKET, move, domain_cut=1)
                status, result = get_json(server, MODEL, data=encode(data))
                self.assertEqual(status, 200, result)
                part, domain = result["part"], result["domain"]
                self.assertAlmostEqual(part["volume"], 388)
                self.assertAlmostEqual(domain["volume"], 12)
                self.assertEqual(part["solids"], 1)
                self.assertEqual(domain["solids"], 1)
                self.assert_bounds(part, [4, -1, -2, 14, 7, 3])
                self.assert_bounds(domain, [6, 0, 1, 9, 2, 3])
                self.assertTrue(domain["edges"])
                self.assertTrue(any(face["plane_z"] is not None for face in domain["faces"]))
                self.assertTrue(all(len(face["positions"]) % 9 == 0 for face in domain["faces"]))

    def test_step_round_trip_and_cylindrical_volume(self):
        operation = {"type": "extrude", "profile": "circle", "x": 3, "y": 4, "z": 0,
                     "radius": 2, "height": 2}
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                for target, data, volume in (
                    ("part", document(operation), 8 * math.pi),
                    ("domain", document(BLOCK, POCKET, domain_cut=1), 12),
                ):
                    with self.subTest(target=target):
                        request = Request(server + f"/api/cad/export/{target}.step", data=encode(data),
                                          headers={"Content-Type": "application/json"})
                        with urlopen(request, timeout=20) as response:
                            self.assertIn(f"{target}.step", response.headers["Content-Disposition"])
                            step = response.read()
                        self.assertTrue(step.startswith(b"ISO-10303-21;"))
                        imported = {"type": "import", "name": "round-trip.step",
                                    "step": base64.b64encode(step).decode("ascii")}
                        status, result = get_json(server, MODEL, data=encode(document(imported)))
                        self.assertEqual(status, 200, result)
                        self.assertAlmostEqual(result["part"]["volume"], volume)

    def test_invalid_geometry_is_reported(self):
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                for data in (
                    document({**BLOCK, "height": 0}),
                    document(BLOCK, {**POCKET, "x": 500}),
                    document(BLOCK, domain_cut=0),
                    document({"type": "import", "name": "broken.step", "step": "eA=="}),
                    {"version": 2, "operations": []},
                ):
                    with self.subTest(data=data):
                        status, result = get_json(server, MODEL, data=encode(data))
                        self.assertEqual(status, 400, result)
                        self.assertTrue(result["error"])

                request = Request(server + "/api/cad/export/domain.step", data=encode(document(BLOCK)),
                                  headers={"Content-Type": "application/json"})
                with self.assertRaises(HTTPError) as missing:
                    urlopen(request, timeout=20)
                self.assertEqual(missing.exception.code, 400)

    def test_persistent_sketch_closed_lines_and_elliptic_hole(self):
        points = [(0, 0), (10, 0), (10, 8), (0, 8)]
        outer = [{"id": f"line-{i}", "kind": "line", "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]}
                 for i, (a, b) in enumerate(zip(points, points[1:] + points[:1]))]
        marker = {"id": "mark", "kind": "point", "x": -2, "y": -2}
        hole = {"id": "hole", "kind": "ellipse", "x": 5, "y": 4, "rx": 2, "ry": 1}
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                open_profile = sketch("base", marker, *outer[:-1])
                status, result = get_json(server, MODEL, data=encode(document(open_profile)))
                self.assertEqual(status, 200, result)
                self.assertIsNone(result["part"])
                self.assertEqual(result["sketches"][0]["entities"][0], marker)
                self.assertEqual(result["sketches"][0]["regions"], [])

                complete = sketch("base", marker, *outer, hole)
                data = document(complete, pull("base", "line-0", 3))
                status, result = get_json(server, MODEL, data=encode(data))
                self.assertEqual(status, 200, result)
                self.assertAlmostEqual(result["part"]["volume"], (80 - 2 * math.pi) * 3, places=5)
                self.assert_bounds(result["part"], [0, 0, 0, 10, 8, 3])
                self.assertEqual(len(result["sketches"][0]["entities"]), 6)
                self.assertTrue(result["sketches"][0]["regions"][0]["positions"])
                profiles = result["sketches"][0]["profiles"]
                self.assertEqual([item["id"] for item in profiles], ["line-0", "hole"])
                self.assertEqual(profiles[0]["entityIds"], [item["id"] for item in outer])

                edited = sketch("base", marker, *outer, {**hole, "rx": 3})
                status, result = get_json(server, MODEL, data=encode(document(edited, data["operations"][1])))
                self.assertEqual(status, 200, result)
                self.assertAlmostEqual(result["part"]["volume"], (80 - 3 * math.pi) * 3, places=5)

    def test_pulling_into_and_away_from_an_existing_vertical_face(self):
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                status, result = get_json(server, MODEL, data=encode(document(BLOCK)))
                self.assertEqual(status, 200, result)
                plane = next(face["plane"] for face in result["part"]["faces"]
                             if face["plane"] and all(math.isclose(x, 10) for x in face["positions"][::3]))
                local = [value - origin for value, origin in zip([10, 4, 2.5], plane["origin"])]
                center_x, center_y = [sum(value * axis for value, axis in zip(local, plane[name])) for name in ("x", "y")]
                circle = {"id": "cross-section", "kind": "circle", "x": center_x, "y": center_y, "radius": 1}
                side_sketch = sketch("side", circle, plane=plane)

                for distance, volume in ((2, 400 + 2 * math.pi), (-2, 400 - 2 * math.pi)):
                    with self.subTest(distance=distance):
                        data = document(BLOCK, side_sketch, pull("side", "cross-section", distance),
                                        domain_cut=2 if distance < 0 else None)
                        status, result = get_json(server, MODEL, data=encode(data))
                        self.assertEqual(status, 200, result)
                        self.assertAlmostEqual(result["part"]["volume"], volume, places=5)
                        if distance > 0:
                            self.assert_bounds(result["part"], [0, 0, 0, 12, 8, 5])
                        else:
                            self.assertAlmostEqual(result["domain"]["volume"], 2 * math.pi, places=5)

    def test_fillet_from_a_rendered_edge_reference(self):
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                status, result = get_json(server, MODEL, data=encode(document(BLOCK)))
                self.assertEqual(status, 200, result)
                mesh = result["part"]
                edge = next(reference for points, reference in zip(mesh["edges"], mesh["edge_refs"], strict=True)
                            if all(math.isclose(y, 0) for y in points[1::3])
                            and all(math.isclose(z, 5) for z in points[2::3]))
                rounded = {"type": "fillet", "edge": edge, "radius": 1}
                status, result = get_json(server, MODEL, data=encode(document(BLOCK, rounded)))
                self.assertEqual(status, 200, result)
                self.assertAlmostEqual(result["part"]["volume"], 400 - 10 * (1 - math.pi / 4), places=5)
                self.assertEqual(result["part"]["solids"], 1)
                status, result = get_json(server, MODEL, data=encode(document(BLOCK, {**rounded, "radius": 100})))
                self.assertEqual(status, 400, result)
                self.assertTrue(result["error"])

    def test_direct_planar_face_edit_and_independent_body_history(self):
        separate = {**BLOCK, "x": 30, "width": 4}
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                status, initial = get_json(server, MODEL, data=encode(document(BLOCK, separate)))
                self.assertEqual(status, 200, initial)
                first, second = initial["bodies"]
                self.assertEqual(first["operationIndices"], [0])
                self.assertEqual(second["operationIndices"], [1])
                self.assertAlmostEqual(first["volume"], 400)
                self.assertAlmostEqual(second["volume"], 160)
                face = next(face for face in initial["part"]["faces"]
                            if face["body_id"] == first["id"] and face["plane"]
                            and all(math.isclose(x, 10) for x in face["positions"][::3]))
                for delta in (2, -2):
                    with self.subTest(distance=delta):
                        change = {"type": "face_edit", "body": first["id"], "face": face["ref"], "distance": delta}
                        status, result = get_json(server, MODEL, data=encode(document(BLOCK, separate, change)))
                        self.assertEqual(status, 200, result)
                        updated, untouched = result["bodies"]
                        self.assertEqual(updated["id"], first["id"])
                        self.assertEqual(updated["operationIndices"], [0, 2])
                        self.assertAlmostEqual(updated["volume"], (10 + delta) * 8 * 5, places=5)
                        self.assert_bounds(updated, [0, 0, 0, 10 + delta, 8, 5])
                        self.assertEqual(untouched, second)

    def test_direct_cylindrical_face_edit_changes_exact_radius(self):
        cylinder = {"type": "extrude", "profile": "circle", "x": 0, "y": 0, "z": 0, "radius": 3, "height": 7}
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                status, initial = get_json(server, MODEL, data=encode(document(cylinder)))
                self.assertEqual(status, 200, initial)
                side = next(face for face in initial["part"]["faces"]
                            if (face.get("surface") or {}).get("kind") == "cylinder")
                self.assertAlmostEqual(side["surface"]["radius"], 3)
                self.assertEqual(side["surface"]["sense"], 1)
                for delta in (1.5, -0.5):
                    with self.subTest(distance=delta):
                        edit = {"type": "face_edit", "body": side["body_id"], "face": side["ref"], "distance": delta}
                        status, result = get_json(server, MODEL, data=encode(document(cylinder, edit)))
                        radius = 3 + delta
                        self.assertEqual(status, 200, result)
                        self.assertAlmostEqual(result["part"]["volume"], math.pi * radius ** 2 * 7, places=5)
                        self.assert_bounds(result["part"], [-radius, -radius, 0, radius, radius, 7])

    def test_fillet_history_can_suppress_and_restore_the_same_round(self):
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                status, initial = get_json(server, MODEL, data=encode(document(BLOCK)))
                self.assertEqual(status, 200, initial)
                mesh = initial["part"]
                edge, metadata = next(
                    (reference, meta) for points, reference, meta in zip(mesh["edges"], mesh["edge_refs"], mesh["edge_meta"], strict=True)
                    if all(math.isclose(y, 0) for y in points[1::3]) and all(math.isclose(z, 5) for z in points[2::3])
                )
                self.assertGreater(metadata["inward"][1], 0)
                self.assertLess(metadata["inward"][2], 0)
                fillet = {"type": "fillet", "body": metadata["body_id"], "edge": edge, "radius": 1}
                status, rounded = get_json(server, MODEL, data=encode(document(BLOCK, fillet)))
                self.assertEqual(status, 200, rounded)
                self.assertTrue(any(face.get("fillet_index") == 1 for face in rounded["part"]["faces"]))
                self.assertAlmostEqual(rounded["part"]["volume"], 400 - 10 * (1 - math.pi / 4), places=5)
                status, sharp = get_json(server, MODEL, data=encode(document(BLOCK, {**fillet, "radius": 0})))
                self.assertEqual(status, 200, sharp)
                self.assertAlmostEqual(sharp["part"]["volume"], 400)
                self.assertEqual(len(sharp["part"]["faces"]), 6)
                self.assertEqual(sharp["bodies"][0]["operationIndices"], [0, 1])
                status, restored = get_json(server, MODEL, data=encode(document(BLOCK, fillet)))
                self.assertEqual(status, 200, restored)
                self.assertAlmostEqual(restored["part"]["volume"], rounded["part"]["volume"])

    def test_merging_crossed_sketch_outlines_preserves_exact_area_and_alias(self):
        first = {"id": "a", "kind": "rectangle", "x": 0, "y": 0, "width": 8, "length": 6}
        second = {"id": "b", "kind": "rectangle", "x": 5, "y": 2, "width": 7, "length": 6}
        separate = {"id": "c", "kind": "circle", "x": 20, "y": 0, "radius": 2}
        original = sketch("overlap", first, second, separate)
        merged = {**original, "mergeRegions": ["b"]}
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                status, before = get_json(server, MODEL, data=encode(document(original)))
                self.assertEqual(status, 200, before)
                self.assertEqual(before["sketches"][0]["overlapGroups"], [["a", "b"]])
                profiles = before["sketches"][0]["profiles"]
                self.assertEqual([item["id"] for item in profiles], ["a", "b", "c"])
                status, after = get_json(server, MODEL, data=encode(document(merged, pull("overlap", "b", 2))))
                self.assertEqual(status, 200, after)
                planar = after["sketches"][0]
                self.assertCountEqual([region["id"] for region in planar["regions"]], ["a", "c"])
                self.assertEqual(planar["hiddenEntityIds"], ["a", "b"])
                self.assertEqual(planar["profiles"], profiles)
                outline = next(region["outlines"] for region in planar["regions"] if region["id"] == "a")
                self.assertEqual(len(outline), 8)
                self.assertAlmostEqual(after["part"]["volume"], (48 + 42 - 12) * 2, places=5)

    def test_coincident_contours_remain_independently_addressable(self):
        plane = {"origin": [10, 2, 3], "x": [0, 1, 0], "y": [0, 0, 1]}
        first = {"id": "base", "kind": "rectangle", "x": 0, "y": 0, "width": 6, "length": 4}
        second = {**first, "id": "target"}
        moved = {**second, "x": 4, "y": -2}
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                initial = sketch("vertical", first, second, plane=plane)
                status, result = get_json(server, MODEL, data=encode(document(initial)))
                self.assertEqual(status, 200, result)
                base_profile, target_profile = result["sketches"][0]["profiles"]
                self.assertEqual(base_profile["entityIds"], ["base"])
                self.assertEqual(target_profile["entityIds"], ["target"])
                self.assertCountEqual(base_profile["positions"], target_profile["positions"])

                edited = sketch("vertical", first, moved, plane=plane)
                status, result = get_json(server, MODEL, data=encode(document(edited)))
                self.assertEqual(status, 200, result)
                self.assertIsNone(result["part"])
                updated_base, updated_target = result["sketches"][0]["profiles"]
                self.assertEqual(updated_base, base_profile)
                self.assertEqual(updated_target["id"], target_profile["id"])
                positions = updated_target["positions"]
                self.assertEqual(set(positions[::3]), {10})
                self.assertEqual(set(positions[1::3]), {6, 12})
                self.assertEqual(set(positions[2::3]), {1, 5})

    def test_divider_creates_two_exact_pull_regions_and_marks_open_endpoints(self):
        corners = [(0, 0), (8, 0), (8, 6), (0, 6)]
        segments = [
            dict(id=f"side-{i}", kind="line", x1=a[0], y1=a[1], x2=b[0], y2=b[1])
            for i, (a, b) in enumerate(zip(corners, corners[1:] + corners[:1]))
        ]
        divider = dict(id="divider", kind="line", x1=0, y1=0, x2=8, y2=6)
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                profile = sketch("split", *segments, divider)
                status, result = get_json(server, MODEL, data=encode(document(profile)))
                self.assertEqual(status, 200, result)
                planar = result["sketches"][0]
                self.assertEqual(len(planar["regions"]), 2)
                self.assertEqual(planar["openPoints"], [])
                for region in planar["regions"]:
                    self.assertEqual(len(region["outlines"]), 3)
                    status, result = get_json(server, MODEL, data=encode(document(profile, pull("split", region["id"], 2))))
                    self.assertEqual(status, 200, result)
                    self.assertAlmostEqual(result["part"]["volume"], 48)

                gap_at = {**segments[-1], "y2": 0.01}
                status, result = get_json(server, MODEL, data=encode(document(sketch("open", *segments[:-1], gap_at))))
                self.assertEqual(status, 200, result)
                self.assertFalse(result["sketches"][0]["regions"])
                points = sorted(result["sketches"][0]["openPoints"])
                self.assertEqual(len(points), 2)
                self.assertEqual([x for x, _ in points], [0, 0])
                self.assertAlmostEqual(points[0][1], 0)
                self.assertAlmostEqual(points[1][1], 0.01)

    def test_circular_channel_cut_exports_exact_step(self):
        plate = {**BLOCK, "x": -1, "y": -3, "width": 12, "length": 6, "height": 1}
        plane = {**XY, "origin": [0, 0, 1]}
        def rail(id, y):
            return dict(id=id, kind="line", x1=0, y1=y, x2=8, y2=y)
        def bend(id, radius):
            return dict(id=id, kind="arc", x=8, y=0, radius=radius, startAngle=-math.pi / 2, sweep=math.pi)
        def cap(id, y1, y2):
            return dict(id=id, kind="line", x1=0, y1=y1, x2=0, y2=y2)
        profile = sketch("channel", rail("out-l", -2.5), bend("out-r", 2.5), rail("out-u", 2.5),
                         rail("in-l", -1.5), bend("in-r", 1.5), rail("in-u", 1.5),
                         cap("cap-l", -2.5, -1.5), cap("cap-u", 1.5, 2.5), plane=plane)
        expected = (16 + 2 * math.pi) * 0.5
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                status, result = get_json(server, MODEL, data=encode(document(plate, profile)))
                self.assertEqual(status, 200, result)
                regions = result["sketches"][0]["regions"]
                self.assertEqual(len(regions), 1)
                cut = {**pull("channel", regions[0]["id"], -0.5), "mode": "cut", "body": "body-1-1"}
                design = document(plate, profile, cut, domain_cut=2)
                status, result = get_json(server, MODEL, data=encode(design))
                self.assertEqual(status, 200, result)
                self.assertAlmostEqual(result["domain"]["volume"], expected, places=7)
                request = Request(server + "/api/cad/export/domain.step", data=encode(design),
                                  headers={"Content-Type": "application/json"})
                with urlopen(request, timeout=20) as response:
                    step = response.read()
                imported = {"type": "import", "name": "channel.step", "step": base64.b64encode(step).decode("ascii")}
                status, result = get_json(server, MODEL, data=encode(document(imported)))
                self.assertEqual(status, 200, result)
                self.assertAlmostEqual(result["part"]["volume"], expected, places=7)
                arcs = [meta["curve"]["radius"] for meta in result["part"]["edge_meta"]
                        if meta["curve"] and meta["curve"]["kind"] == "arc"]
                self.assertEqual({round(radius, 7) for radius in arcs}, {1.5, 2.5})

                revised = sketch("channel", rail("out-l", -2.8), bend("out-r", 2.8), rail("out-u", 2.8),
                                 rail("in-l", -1.6), bend("in-r", 1.6), rail("in-u", 1.6),
                                 cap("cap-l", -2.8, -1.6), cap("cap-u", 1.6, 2.8), plane=plane)
                status, edited = get_json(server, MODEL, data=encode(document(plate, revised, cut, domain_cut=2)))
                self.assertEqual(status, 200, edited)
                refreshed = edited["sketches"][0]
                self.assertEqual([region["id"] for region in refreshed["regions"]], [cut["region"]])
                self.assertEqual(refreshed["openPoints"], [])
                self.assertAlmostEqual(edited["domain"]["volume"], 1.2 * (16 + 2.2 * math.pi) * 0.5, places=7)

    def test_fillet_on_a_full_box_edge_rebinds_after_sketch_resize(self):
        rectangle = dict(id="box", kind="rectangle", x=0, y=0, width=10, length=8)
        base = sketch("base", rectangle)
        extrusion = pull("base", "box", 5)
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                status, result = get_json(server, MODEL, data=encode(document(base, extrusion)))
                self.assertEqual(status, 200, result)
                mesh = result["part"]
                reference = next(ref for ref, meta in zip(mesh["edge_refs"], mesh["edge_meta"], strict=True)
                                 if meta["curve"]["kind"] == "line" and
                                 {tuple(meta["curve"]["start"]), tuple(meta["curve"]["end"])} == {(0, 0, 5), (10, 0, 5)})
                fillet = dict(type="fillet", body="body-2-1", edge=reference, radius=1)
                status, initial = get_json(server, MODEL, data=encode(document(base, extrusion, fillet)))
                self.assertEqual(status, 200, initial)
                self.assertEqual(initial["filletCorners"]["2"], [0, -1, 1])
                larger = sketch("base", {**rectangle, "width": 12})
                status, failed = get_json(server, MODEL, data=encode(document(larger, extrusion, fillet)))
                self.assertEqual(status, 400, failed)
                self.assertEqual(failed["operationIndex"], 2)
                anchored = {**fillet, "edgeCorner": initial["filletCorners"]["2"]}
                status, result = get_json(server, MODEL, data=encode(document(larger, extrusion, anchored)))
                self.assertEqual(status, 200, result)
                self.assertAlmostEqual(result["part"]["volume"], 480 - 12 * (1 - math.pi / 4), places=6)

    def test_pull_explicit_fuse_or_through_cut_and_touch_join(self):
        plane = {**XY, "origin": [0, 0, -2]}
        opening = {"id": "opening", "kind": "rectangle", "x": 1, "y": 1, "width": 3, "length": 2}
        tool = sketch("tool", opening, plane=plane)
        event = pull("tool", "opening", 9)
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                for mode, expected in (("join", 424), ("cut", 370)):
                    with self.subTest(mode=mode):
                        project = document(BLOCK, tool, {**event, "mode": mode}, domain_cut=2 if mode == "cut" else None)
                        status, result = get_json(server, MODEL, data=encode(project))
                        self.assertEqual(status, 200, result)
                        self.assertEqual(len(result["bodies"]), 1)
                        self.assertAlmostEqual(result["part"]["volume"], expected)
                        if mode == "cut":
                            self.assertAlmostEqual(result["domain"]["volume"], 30)
                touch = {**event, "distance": 2, "mode": "join"}
                status, result = get_json(server, MODEL, data=encode(document(BLOCK, tool, touch)))
                self.assertEqual(status, 200, result)
                self.assertEqual(len(result["bodies"]), 1)
                self.assertAlmostEqual(result["part"]["volume"], 412)

    def test_sketch_cylinder_side_and_both_caps(self):
        profile = {"id": "round", "kind": "circle", "x": 0, "y": 0, "radius": 3}
        commands = (sketch("base", profile), pull("base", "round", 7))
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                status, base = get_json(server, MODEL, data=encode(document(*commands)))
                self.assertEqual(status, 200, base)
                faces = base["part"]["faces"]
                side = next(face for face in faces if (face.get("surface") or {}).get("kind") == "cylinder")
                self.assertEqual(side["surface"]["sense"], 1)
                seam = next(meta for edge, meta in zip(base["part"]["edges"], base["part"]["edge_meta"], strict=True)
                            if len(edge) == 6 and math.isclose(abs(edge[5] - edge[2]), 7))
                self.assertFalse(seam["fillet_enabled"])
                for delta in (-1, 1):
                    with self.subTest(radial=delta):
                        edit = {"type": "face_edit", "body": side["body_id"], "face": side["ref"], "distance": delta}
                        status, result = get_json(server, MODEL, data=encode(document(*commands, edit)))
                        self.assertEqual(status, 200, result)
                        self.assertAlmostEqual(result["part"]["volume"], math.pi * (3 + delta) ** 2 * 7, places=5)
                for old_z, minimum_z, maximum_z in ((0, -4, 7), (7, 0, 11)):
                    with self.subTest(cap=old_z):
                        cap = next(face for face in faces if face.get("plane_z") == old_z and face.get("cylinder"))
                        self.assertAlmostEqual(cap["cylinder"]["height"], 7)
                        self.assertAlmostEqual(cap["cylinder"]["radius"], 3)
                        edit = {"type": "cylinder_edit", "body": cap["body_id"], "face": cap["ref"], "height": 11, "radius": 2.5}
                        status, result = get_json(server, MODEL, data=encode(document(*commands, edit)))
                        self.assertEqual(status, 200, result)
                        self.assert_bounds(result["part"], [-2.5, -2.5, minimum_z, 2.5, 2.5, maximum_z])
                        self.assertAlmostEqual(result["part"]["volume"], math.pi * 2.5 ** 2 * 11, places=5)

    def test_delete_only_the_selected_body(self):
        second = {**BLOCK, "x": 30, "height": 2}
        with tempfile.TemporaryDirectory(prefix="openfoam-cad-test-") as temporary:
            with running_server(Path(temporary)) as server:
                status, base = get_json(server, MODEL, data=encode(document(BLOCK, second)))
                self.assertEqual(status, 200, base)
                a, b = base["bodies"]
                status, result = get_json(server, MODEL, data=encode(document(BLOCK, second, {"type": "delete_body", "body": a["id"]})))
                self.assertEqual(status, 200, result)
                self.assertEqual(result["bodies"], [b])
                self.assertAlmostEqual(result["part"]["volume"], 160)


if __name__ == "__main__":
    unittest.main()
