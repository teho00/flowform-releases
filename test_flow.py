"""Check the local CAD-to-CFD handoff with a real mesher and no solver."""

import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from urllib.request import urlopen
from zipfile import ZipFile

import cad_model
import flow_setup
from test_app import get_json, running_server


DOCUMENT = {
    "version": 1,
    "operations": [
        {"type": "extrude", "profile": "rectangle", "x": 0, "y": 0, "z": 0,
         "width": 4, "length": 3, "height": 1},
        {"type": "cut", "profile": "rectangle", "x": 0, "y": 1, "z": 1,
         "width": 4, "length": 1, "height": 0.5},
    ],
    "domainCut": 1,
}


@unittest.skipUnless(cad_model.KERNEL_READY and flow_setup.gmsh_available(), "CAD and Gmsh are required")
class FlowHandoffTest(unittest.TestCase):
    def test_mesh_handoff_conditions_download_and_history(self):
        with TemporaryDirectory() as temporary:
            archive = Path(temporary)
            with running_server(archive, demo=True) as server:
                def post(path, body):
                    return get_json(server, path, data=json.dumps(body).encode())

                status, env = get_json(server, "/api/flow/environment")
                self.assertEqual(status, 200)
                self.assertTrue(env["mesh_ready"])
                self.assertFalse(env["ready"])
                status, geometry = post("/api/flow/domain", DOCUMENT)
                self.assertEqual(status, 200, geometry)
                faces = [face for face in geometry["domain"]["faces"] if face.get("normal") in ([-1, 0, 0], [1, 0, 0])]
                inlet, outlet = sorted(faces, key=lambda face: face["center_mm"][0])
                setup = {
                    "document": DOCUMENT, "inlet_ref": inlet["ref"], "outlet_ref": outlet["ref"],
                    "mode": "transient", "fluid": "water", "mesh_only": True, "mesh_mm": 0.25,
                    "rho": 998, "mu": 0.001, "inlet_speed_m_s": 0.15, "outlet_pressure_pa": 0,
                    "end_time_s": 0.02, "time_step_s": 0.001,
                }
                self.assertEqual(post("/api/flow/runs", dict(setup, outlet_ref=inlet["ref"]))[0], 400)
                self.assertEqual(post("/api/flow/runs", dict(setup, outlet_ref="stale-reference"))[0], 400)
                self.assertEqual(post("/api/flow/runs", dict(setup, mesh_only=False))[0], 503)
                self.assertEqual(post("/api/flow/runs", dict(setup, mesh_method="unknown"))[0], 400)
                status, accepted = post("/api/flow/runs", setup)
                self.assertEqual(status, 202, accepted)
                route = f"/api/flow/runs/{accepted['id']}"
                deadline = time.monotonic() + 25
                while True:
                    _, detail = get_json(server, route)
                    if detail["status"] in ("complete", "failed") or time.monotonic() > deadline:
                        break
                    time.sleep(0.05)
                self.assertEqual(detail["status"], "complete", detail)
                self.assertEqual(detail["stage"], "mesh")
                self.assertGreater(detail["mesh"]["cells"], 0)
                self.assertEqual(detail["mesh"]["method"], "hex-dominant")
                self.assertAlmostEqual(detail["mesh"]["inlet_area_mm2"], 0.5)
                self.assertAlmostEqual(detail["mesh"]["outlet_area_mm2"], 0.5)
                self.assertEqual(detail["files"], {"mesh": True, "case": True, "csv": False})
                self.assertIsNone(detail["summary"])
                self.assertIn("log.gmsh", detail["logs"])
                with urlopen(server + route + "/case.zip") as response:
                    with ZipFile(io.BytesIO(response.read())) as exported:
                        self.assertIn("domain.msh", exported.namelist())
                        self.assertIn(b"maxDeltaT 0.001", exported.read("system/controlDict"))
                        self.assertIn(b"value uniform (0.15 0 0)", exported.read("0/U"))
                _, benchmark = get_json(server, "/api/runs")
                self.assertEqual(benchmark["runs"], [])

            with running_server(archive, demo=True) as server:
                _, saved = get_json(server, route)
                self.assertEqual(saved["status"], "complete")
                self.assertEqual(saved["files"], detail["files"])
