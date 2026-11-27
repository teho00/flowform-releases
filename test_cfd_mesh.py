"""Regression checks for the CAD-to-Gmsh boundary and unit conversion."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cad_model
from flow_setup import gmsh_available


HERE = Path(__file__).resolve().parent


@unittest.skipUnless(cad_model.KERNEL_READY and gmsh_available(), "CAD and Gmsh are required")
class MeshTests(unittest.TestCase):
    def make_input(self, case):
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

        domain = BRepPrimAPI_MakeBox(3, 1, 0.5).Shape()
        writer = cad_model.STEPControl_Writer()
        self.assertEqual(writer.Transfer(domain, cad_model.STEPControl_AsIs), cad_model.IFSelect_RetDone)
        self.assertEqual(writer.Write(str(case / "domain.step")), cad_model.IFSelect_RetDone)
        setup = {"mesh_mm": 0.22}
        for name, x in (("inlet", 0), ("outlet", 3)):
            setup[name] = {
                "center_mm": [x, 0.5, 0.25],
                "bounds_mm": [x, 0, 0, x, 1, 0.5],
                "area_mm2": 0.5,
            }
        return setup

    def generate(self, case, setup):
        (case / "setup.json").write_text(json.dumps(setup), encoding="utf-8")
        return subprocess.run(
            [sys.executable, "-B", str(HERE / "cfd_mesh.py"), str(case)],
            encoding="utf-8", errors="replace", capture_output=True, timeout=45, check=False,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )

    def test_hexahedral_ports_and_export_units(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory)
            setup = {**self.make_input(case), "mesh_method": "hex-sweep"}
            result = self.generate(case, setup)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads((case / "mesh.json").read_text(encoding="utf-8"))
            self.assertAlmostEqual(report["volume_mm3"], 1.5)
            self.assertGreater(report["orthogonal_quality"]["min"], 0.9)
            text = (case / "domain.msh").read_text(encoding="ascii")
            node_lines = text.split("$Nodes\n")[1].split("$EndNodes")[0].splitlines()[1:]
            points = {}
            for line in node_lines:
                label, *xyz = line.split()
                points[label] = tuple(map(float, xyz))
            self.assertAlmostEqual(max(point[0] for point in points.values()), 0.003)
            self.assertAlmostEqual(max(point[2] for point in points.values()), 0.0005)

            physical_tags = {"inlet": 1, "outlet": 2, "walls": 3, "fluid": 4}
            physical_faces = {tag: [] for tag in physical_tags.values()}
            element_lines = text.split("$Elements\n")[1].split("$EndElements")[0].splitlines()[1:]
            for line in element_lines:
                _, kind, tag_count, tag, *remaining = line.split()
                self.assertEqual(kind, "5" if tag == "4" else "3")
                physical_faces[int(tag)].append(remaining[int(tag_count) - 1:])
            self.assertEqual(len(physical_faces[4]), report["cells"])
            for patch in ("inlet", "outlet", "walls"):
                faces = physical_faces[physical_tags[patch]]
                self.assertGreater(len(faces), 0)
                self.assertEqual(len(faces), report["patch_faces"][patch])
            for tag, x in ((1, 0), (2, 0.003)):
                port_points = [points[node] for face in physical_faces[tag] for node in face]
                self.assertTrue(all(abs(point[0] - x) < 1e-10 for point in port_points))
                self.assertAlmostEqual(min(point[1] for point in port_points), 0)
                self.assertAlmostEqual(max(point[1] for point in port_points), 0.001)

    def test_explicit_tetrahedral_mesh_methods(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory)
            setup = self.make_input(case)
            for method in ("gmsh-tetra", "tetra-hxt"):
                with self.subTest(method=method):
                    result = self.generate(case, {**setup, "mesh_method": method})
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    report = json.loads((case / "mesh.json").read_text(encoding="utf-8"))
                    self.assertEqual(report["method"], method)
                    text = (case / "domain.msh").read_text(encoding="ascii")
                    elements = text.split("$Elements\n")[1].split("$EndElements")[0].splitlines()[1:]
                    self.assertEqual({row.split()[1] for row in elements if row.split()[3] == "4"}, {"4"})

    def test_hex_dominant_contains_only_hexahedra_and_prisms(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory)
            setup = self.make_input(case)
            result = self.generate(case, setup)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads((case / "mesh.json").read_text(encoding="utf-8"))
            self.assertEqual(report["method"], "hex-dominant")
            self.assertGreater(report["cell_types"]["hexahedra"], 0)
            self.assertGreater(report["cell_types"]["prisms"], 0)
            text = (case / "domain.msh").read_text(encoding="ascii")
            elements = text.split("$Elements\n")[1].split("$EndElements")[0].splitlines()[1:]
            fluid_types = {parts[1] for parts in map(str.split, elements) if parts[3] == "4"}
            self.assertEqual(fluid_types, {"5", "6"})

    def test_invalid_port_has_no_mesh(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory)
            setup = self.make_input(case)
            setup["outlet"]["center_mm"][1] = 10
            result = self.generate(case, setup)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("출구 면", result.stderr)
            self.assertFalse((case / "domain.msh").exists())


if __name__ == "__main__":
    unittest.main()
