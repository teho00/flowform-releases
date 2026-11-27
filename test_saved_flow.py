"""Exercise the saved-mesh HTTP workflow with stand-ins for OpenFOAM commands."""

import json
import os
import threading
import time
import unittest
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app
import flow_setup
from test_app import get_json


SOURCE_ID = "0123456789ab"
RUNS_PATH = "/api/flow/runs"
SAVED_SETUP = {
    "mesh_only": True,
    "mesh_mm": 0.2,
    "mesh_method": "hex-sweep",
    "fluid": "air",
    "rho": 1.2,
    "mu": 1.8e-5,
    "mode": "steady",
    "inlet_speed_m_s": 1,
    "outlet_pressure_pa": 0,
    "end_time_s": None,
    "time_step_s": None,
    "inlet": {"normal": [-1, 0, 0], "area_mm2": 0.5},
    "outlet": {"normal": [1, 0, 0], "area_mm2": 0.5},
}
CONDITIONS = {
    "fluid": "custom",
    "rho": 2,
    "mu": 4e-5,
    "mode": "transient",
    "inlet_speed_m_s": 1.25,
    "outlet_pressure_pa": 2,
    "end_time_s": 0.04,
    "time_step_s": 0.002,
}
MSH = b"""$MeshFormat
2.2 0 8
$EndMeshFormat
$PhysicalNames
4
2 1 "inlet"
2 2 "outlet"
2 3 "walls"
3 4 "fluid"
$EndPhysicalNames
$Nodes
4
1 0 0 0
2 0.001 0 0
3 0 0.001 0
4 0 0 0.001
$EndNodes
$Elements
5
1 2 2 1 1 1 3 4
2 2 2 2 2 2 3 4
3 2 2 3 3 1 2 3
4 2 2 3 4 1 2 4
5 4 2 4 1 1 2 3 4
$EndElements
"""
FOAM_LIST = "FoamFile { format ascii; class IOList; }\n"


def create_saved_mesh(runs_dir):
    directory = runs_dir / "flow" / SOURCE_ID
    case = directory / "case"
    case.mkdir(parents=True)
    record = {
        "id": SOURCE_ID, "setup": SAVED_SETUP, "mesh_only": True, "status": "complete",
        "stage": "mesh", "error": None, "created_at": "2026-11-24T00:00:00+00:00",
    }
    (directory / "run.json").write_text(json.dumps(record), encoding="utf-8")
    (case / "setup.json").write_text(json.dumps(SAVED_SETUP), encoding="utf-8")
    (case / "mesh.json").write_text('{"method": "hex-sweep", "cells": 1, "inlet_area_mm2": 0.5}', encoding="utf-8")
    (case / "domain.step").write_bytes(b"ISO-10303-21;")
    (case / "domain.msh").write_bytes(MSH)
    return directory


@contextmanager
def local_server(runs_dir, *, solver_available, capture):
    commands = {name: name for name in flow_setup.COMMANDS} if solver_available else {}
    with (
        patch.dict(os.environ, {"WM_PROJECT_VERSION": "14"}),
        patch.object(flow_setup.shutil, "which", side_effect=commands.get),
        patch.object(flow_setup, "wsl_solver", return_value=None),
        patch.object(flow_setup, "gmsh_available", return_value=False),
        patch.object(app.FlowRuns, "capture", autospec=True, side_effect=capture),
        ThreadingHTTPServer(("127.0.0.1", 0), app.Handler) as server,
    ):
        app.configure_runs(server, runs_dir, demo=False)
        worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            worker.join()
            server.runs.pool.shutdown()
            server.flow_runs.pool.shutdown()


def write_converted_mesh(case):
    mesh = case / "constant" / "polyMesh"
    mesh.mkdir()
    fields = {
        "points": "4((0 0 0)(0.001 0 0)(0 0.001 0)(0 0 0.001))",
        "faces": "4(3(0 2 3)3(1 2 3)3(0 1 2)3(0 1 3))",
        "owner": "4{0}",
        "neighbour": "0()",
        "boundary": """3(
            inlet { type patch; startFace 0; nFaces 1; }
            outlet { type patch; startFace 1; nFaces 1; }
            walls { type patch; startFace 2; nFaces 2; }
        )""",
    }
    for name, data in fields.items():
        (mesh / name).write_text(FOAM_LIST + data, encoding="utf-8")


class FakeSolver:
    def __init__(self, *, mesh_ok=True, tetrahedra=0, solver_error=None):
        self.mesh_ok = mesh_ok
        self.tetrahedra = tetrahedra
        self.solver_error = solver_error
        self.steps = []

    def capture(self, store, command, case, log):
        progress = store.get(case.parent.name)
        self.steps.append((progress["status"], progress["stage"], command))
        name = command[0]
        if name == "gmshToFoam":
            if (case / command[1]).read_bytes() != MSH:
                raise ValueError("The solver did not receive the selected saved mesh")
            write_converted_mesh(case)
            output = "Converted mesh"
        elif name == "checkMesh":
            output = "Mesh OK." if self.mesh_ok else "Mesh OK. was not reported\nFailed 1 mesh checks."
            if self.tetrahedra:
                output += f"\n    tetrahedra: {self.tetrahedra}"
        elif name == "foamRun":
            if self.solver_error:
                log.write_text(self.solver_error, encoding="utf-8")
                return 1
            instant = case / "0.04"
            instant.mkdir()
            (instant / "U").write_text("internalField uniform (1.25 0 0);", encoding="utf-8")
            (instant / "p").write_text(
                "internalField uniform 5; boundaryField { outlet { value uniform 1; } }",
                encoding="utf-8",
            )
            output = "End"
        elif name == "foamPostProcess":
            (case / "0.04" / "C").write_text("internalField uniform (0.00025 0.00025 0.00025);", encoding="utf-8")
            output = "Wrote centres"
        else:
            raise RuntimeError(f"Unexpected subprocess {command}")
        log.write_text(output + "\n", encoding="utf-8")
        return 0


class SavedMeshFlowTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.runs_dir = Path(temporary.name)
        self.source = create_saved_mesh(self.runs_dir)

    def start(self, url, source=SOURCE_ID, **changes):
        path = f"{RUNS_PATH}/{source}/solve"
        body = json.dumps({**CONDITIONS, **changes}).encode()
        return get_json(url, path, data=body)

    def wait_for_run(self, url, run_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status, detail = get_json(url, f"{RUNS_PATH}/{run_id}")
            self.assertEqual(status, 200)
            if detail["status"] in ("complete", "failed"):
                return detail
            time.sleep(0.025)
        self.fail(f"Run {run_id} did not finish")

    def test_reuses_saved_bytes_and_updates_conditions_without_gmsh(self):
        solver = FakeSolver()
        originals = {path: path.read_bytes() for path in self.source.rglob("*") if path.is_file()}
        with local_server(self.runs_dir, solver_available=True, capture=solver.capture) as url:
            _, environment = get_json(url, "/api/flow/environment")
            self.assertFalse(environment["mesh_ready"])
            self.assertTrue(environment["solver_ready"])
            status, accepted = self.start(url, mesh_mm=0.001, inlet={"normal": [0, 1, 0]})
            self.assertEqual(status, 202, accepted)
            self.assertNotEqual(accepted["id"], SOURCE_ID)
            self.assertEqual(accepted["source_mesh_id"], SOURCE_ID)
            detail = self.wait_for_run(url, accepted["id"])
            status, log = get_json(url, f"{RUNS_PATH}/{accepted['id']}/logs/log.checkMesh")
            self.assertEqual(status, 200)
            self.assertEqual(log["text"].strip(), "Mesh OK.")
            contour_path = f"{RUNS_PATH}/{accepted['id']}/contour"
            status, pressure = get_json(url, contour_path + "?field=pressure&axis=z&fraction=0.5")
            self.assertEqual(status, 200, pressure)
            self.assertEqual(pressure["position_mm"], 0.5)
            self.assertEqual(pressure["values"], [10.0])
            self.assertEqual((pressure["unit"], pressure["minimum"], pressure["maximum"]), ("Pa", 2, 10))
            self.assertEqual(pressure["time_directory"], "0.04")
            status, speed = get_json(url, contour_path + "?field=speed")
            self.assertEqual(status, 200, speed)
            self.assertEqual(speed["unit"], "m/s")
            self.assertEqual(speed["values"], [1.25] * 4)
            self.assertEqual(get_json(url, contour_path + "?field=unknown")[0], 400)
            self.assertEqual(get_json(url, f"{RUNS_PATH}/{SOURCE_ID}/contour")[0], 404)
        self.assertEqual(detail["status"], "complete", detail)
        self.assertEqual(detail["stage"], "postprocess")
        self.assertEqual(detail["setup"]["mesh_mm"], SAVED_SETUP["mesh_mm"])
        self.assertEqual(detail["setup"]["inlet"], SAVED_SETUP["inlet"])
        self.assertEqual(detail["setup"]["outlet"], SAVED_SETUP["outlet"])
        self.assertEqual({key: detail["setup"][key] for key in CONDITIONS}, CONDITIONS)
        self.assertEqual(detail["summary"]["pressure_drop_pa"], 8.0)
        self.assertTrue(detail["contours"])
        self.assertTrue(detail["files"]["csv"])
        self.assertNotIn("log.gmsh", detail["logs"])
        self.assertEqual(
            solver.steps,
            [
                ("running", "convert", ["gmshToFoam", "domain.msh"]),
                ("running", "checkMesh", ["checkMesh"]),
                ("running", "foamRun", ["foamRun"]),
                ("running", "postprocess", ["foamPostProcess", "-latestTime", "-func", "writeCellCentres"]),
            ],
        )
        case = self.source.parent / accepted["id"] / "case"
        self.assertEqual((case / "domain.msh").read_bytes(), MSH)
        self.assertIn("value uniform (1.25 0 0)", (case / "0" / "U").read_text(encoding="utf-8"))
        self.assertIn("maxDeltaT 0.002;", (case / "system" / "controlDict").read_text(encoding="utf-8"))
        self.assertEqual({path: path.read_bytes() for path in self.source.rglob("*") if path.is_file()}, originals)

    def test_check_mesh_failure_stops_before_foam_run(self):
        solver = FakeSolver(mesh_ok=False)
        with local_server(self.runs_dir, solver_available=True, capture=solver.capture) as url:
            status, accepted = self.start(url)
            self.assertEqual(status, 202, accepted)
            detail = self.wait_for_run(url, accepted["id"])
        self.assertEqual(detail["status"], "failed", detail)
        self.assertEqual(detail["stage"], "checkMesh")
        self.assertIn("log.checkMesh", detail["error"])
        self.assertEqual([step[2][0] for step in solver.steps], ["gmshToFoam", "checkMesh"])
        self.assertTrue(detail["files"]["mesh"])
        self.assertFalse(detail["files"]["csv"])
        self.assertEqual(detail["failure"]["message"], "OpenFOAM 격자 검사에서 1개 항목을 통과하지 못했습니다.")
        self.assertEqual(detail["failure"]["log"], "log.checkMesh")

    def test_solver_failure_explains_transient_divergence(self):
        solver = FakeSolver(solver_error=(
            "Courant Number mean: 4 max: 20000\nTime = 0.002s\n"
            "Courant Number mean: 500 max: 2e8\nTime = 0.004s\n"
            "--> FOAM FATAL ERROR: \nGPU pressure residual 1.5e-05 failed convergence for p\n\nFOAM exiting\n"
        ))
        with local_server(self.runs_dir, solver_available=True, capture=solver.capture) as url:
            status, accepted = self.start(url, step_count=20)
            self.assertEqual(status, 202, accepted)
            detail = self.wait_for_run(url, accepted["id"])
        failure = detail["failure"]
        self.assertEqual(failure["title"], "비정상 해석 수치 발산")
        self.assertIn("Δt 0.002 s", " ".join(failure["facts"]))
        self.assertIn("20,000", " ".join(failure["facts"]))
        self.assertEqual(failure["excerpt"], "GPU pressure residual 1.5e-05 failed convergence for p")
        self.assertIn("입구 유량과 단위", failure["advice"])
        self.assertEqual(failure["log"], "log.foamRun")

    def test_unknown_and_unavailable_runs_do_not_queue(self):
        solver = FakeSolver()
        with local_server(self.runs_dir, solver_available=False, capture=solver.capture) as url:
            self.assertEqual(self.start(url, source="111111111111")[0], 404)
            self.assertEqual(self.start(url)[0], 503)
            status, history = get_json(url, RUNS_PATH)
            self.assertEqual(status, 200)
            self.assertEqual([run["id"] for run in history["runs"]], [SOURCE_ID])
        self.assertEqual(solver.steps, [])

    def test_saved_tetrahedral_mesh_can_be_selected_for_reuse(self):
        (self.source / "case" / "mesh.json").write_text(
            '{"method": "tetra-hxt", "cells": 1, "inlet_area_mm2": 0.5}', encoding="utf-8"
        )
        solver = FakeSolver(tetrahedra=1)
        with local_server(self.runs_dir, solver_available=True, capture=solver.capture) as url:
            status, detail = get_json(url, f"{RUNS_PATH}/{SOURCE_ID}")
            self.assertEqual(status, 200)
            self.assertTrue(detail["files"]["mesh"])
            self.assertTrue(detail["mesh_reusable"])
            status, accepted = self.start(url)
            self.assertEqual(status, 202, accepted)
            self.assertEqual(self.wait_for_run(url, accepted["id"])["status"], "complete")

    def test_refinement_rejects_unknown_meshing_method(self):
        solver = FakeSolver()
        with local_server(self.runs_dir, solver_available=True, capture=solver.capture) as url:
            self.assertEqual(self.start(url, mode="steady", refine=True, mesh_method="unknown")[0], 400)
        self.assertEqual(solver.steps, [])

    def test_tetrahedral_cells_stop_the_solver_even_with_hex_metadata(self):
        solver = FakeSolver(tetrahedra=1)
        with local_server(self.runs_dir, solver_available=True, capture=solver.capture) as url:
            status, accepted = self.start(url)
            self.assertEqual(status, 202)
            detail = self.wait_for_run(url, accepted["id"])
        self.assertEqual(detail["status"], "failed")
        self.assertIn("사면체", detail["error"])
        self.assertEqual([step[2][0] for step in solver.steps], ["gmshToFoam", "checkMesh"])


if __name__ == "__main__":
    unittest.main()
