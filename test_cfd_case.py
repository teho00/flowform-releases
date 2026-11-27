"""Regression checks for CAD case setup and post-processing without a solver."""

import csv
import tempfile
import unittest
from pathlib import Path

import cfd_case


STEADY = {
    "inlet": {"normal": [-1, 0, 0]},
    "outlet": {"normal": [-1, 0, 0]},
    "mesh_mm": 0.2,
    "fluid": "custom",
    "rho": 2.0,
    "mu": 3e-5,
    "inlet_speed_m_s": 0.75,
    "outlet_pressure_pa": 6,
    "mode": "steady",
}
TRANSIENT = {**STEADY, "mode": "transient", "time_step_s": 0.0001, "end_time_s": 0.02}


class CfdCaseTests(unittest.TestCase):
    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.case = Path(root.name)

    def stored(self, filename):
        return (self.case / filename).read_text(encoding="utf-8")

    def fixture(self, instant):
        mesh = self.case / "constant" / "polyMesh"
        mesh.mkdir(parents=True)
        time = self.case / instant
        time.mkdir()
        prefix = "FoamFile { format ascii; class IOList; }\n"
        # Two tetrahedra sharing face 0. Insets on the two cells have areas 0.5 and 2.
        files = {
            mesh / "points": prefix + "5\n((0 0 0)(2 0 0)(0 1 0)(0 0 1)(0 0 -2))\n",
            mesh / "faces": prefix + "7(3(0 1 2)3(0 2 3)3(0 1 4)3(0 1 3)3(1 2 3)3(0 2 4)3(1 2 4))",
            mesh / "owner": prefix + "7(0 0 1 0 0 1 1)",
            mesh / "neighbour": prefix + "1(1)",
            mesh / "boundary": prefix + """4(
              inlet { type patch; startFace 1; nFaces 2; }
              outlet { type patch; startFace 3; nFaces 1; }
              walls { type patch; startFace 4; nFaces 3; }
              defaultFaces { type patch; startFace 7; nFaces 0; }
            )""",
            time / "U": "internalField nonuniform List<vector> 2((3 4 0)(0 0 -12));",
            time / "C": "internalField nonuniform List<vector> 2((0.5 0.25 0.25)(0.5 0.25 -0.5));",
            time / "p": ("internalField nonuniform List<scalar> 2(4 10);"
                         "boundaryField { inlet { type zeroGradient; } outlet { type fixedValue; value uniform 3; } }"),
            time / "phi": ("boundaryField { inlet { type calculated; value nonuniform List<scalar> 2(-0.1 -0.2); }"
                           "outlet { type calculated; value uniform 0.297; } }"),
        }
        for path, text in files.items():
            path.write_text(text, encoding="utf-8")

    def test_prepare_both_modes_with_inward_velocity_and_kinematic_pressure(self):
        (self.case / "domain.step").write_text("geometry", encoding="utf-8")
        cfd_case.prepare(self.case, STEADY)
        self.assertEqual(self.stored("domain.step"), "geometry")
        self.assertIn("inlet  { type fixedValue; value uniform (0.75 0 0); }", self.stored("0/U"))
        self.assertIn("outlet { type fixedValue; value uniform 3; }", self.stored("0/p"))
        self.assertIn("nu [0 2 -1 0 0 0 0] 1.5e-05;", self.stored("constant/physicalProperties"))
        self.assertIn("default steadyState;", self.stored("system/fvSchemes"))
        self.assertIn("SIMPLE", self.stored("system/fvSolution"))
        cfd_case.prepare(self.case, TRANSIENT)
        self.assertIn("default Euler;", self.stored("system/fvSchemes"))
        self.assertIn("PIMPLE", self.stored("system/fvSolution"))
        self.assertIn("maxDeltaT 0.0001;", self.stored("system/controlDict"))
        self.assertIn("writeInterval 0.02;", self.stored("system/controlDict"))

    def test_transient_diagnostics_keep_last_final_solve_and_skip_unfinished_steps(self):
        log = self.case / "log.foamRun"
        bad_step = ("Courant Number mean: 0.1 max: 0.8\nTime = {time}s\n"
                    "smoothSolver: Solving for Ux, Initial residual = 0.3, Final residual = 1e-12\n"
                    "GAMG: Solving for p, Initial residual = 0.7, Final residual = 1e-3\n"
                    "GAMG: Solving for p, Initial residual = 0.1, Final residual = 2e-8\n")
        log.write_text(bad_step.format(time=0.001) + "End\n" + bad_step.format(time=0.0015), encoding="utf-8")
        data = cfd_case.residual_progress(log, transient=True)
        self.assertEqual(data["residuals"][0]["p"], 0.7)
        diagnostics = data["diagnostics"]
        self.assertEqual(diagnostics["checked_steps"], 1)
        self.assertIsNone(diagnostics["first_repeated"])
        current = diagnostics["current"]
        self.assertAlmostEqual(current["delta_t"], 0.0005)
        self.assertEqual(current["max_courant"], 0.8)
        self.assertEqual(current["final"]["p"], 2e-8)
        with log.open("a") as source:
            source.write("End\nCourant Number mean: 0 max: inf\nTime = 0.002s\n"
                         "GAMG: Solving for p, Initial residual = nan, Final residual = nan\n")
        diagnostics = cfd_case.residual_progress(log, transient=True)["diagnostics"]
        self.assertEqual(diagnostics["above_target"], 2)
        self.assertEqual(diagnostics["first_repeated"], {"step": 1, "time": 0.001})
        self.assertEqual(diagnostics["first_nonfinite"], {"step": 3, "time": 0.002})
        self.assertIsNone(diagnostics["current"]["max_courant"])

    def test_analysis_uses_area_weights_and_retains_full_velocity_csv(self):
        self.fixture("200")
        (self.case / "log.foamRun").write_text("SIMPLE solution converged in 200 iterations")
        cfd_case.set_wall_type(self.case)
        self.assertIn("walls { type wall;", self.stored("constant/polyMesh/boundary"))
        summary, profile = cfd_case.analyse(self.case, STEADY)
        self.assertEqual(cfd_case.read_results(self.case), (summary, profile))
        self.assertEqual(summary["cells"], 2)
        self.assertEqual(summary["inlet_mesh_area_m2"], 2.5)
        self.assertAlmostEqual(summary["pressure_drop_pa"], 11.6)
        self.assertAlmostEqual(summary["flux_imbalance_percent"], 1)
        self.assertEqual(summary["max_speed_m_s"], 12)
        self.assertTrue(summary["steady_converged"])
        self.assertEqual(profile[0]["speed_m_s"], 5)
        self.assertEqual(profile[1]["pressure_pa"], 20)
        csv_rows = list(csv.DictReader(self.stored("analysis/profile.csv").splitlines()))
        self.assertEqual(len(csv_rows), 2)
        self.assertEqual(csv_rows[1]["uz_m_s"], "-12.0")

    def test_transient_requires_end_time_and_does_not_fabricate_missing_flux(self):
        self.fixture("0.01")
        with self.assertRaisesRegex(ValueError, "종료 시각"):
            cfd_case.analyse(self.case, TRANSIENT)
        (self.case / "0.01").rename(self.case / "0.02")
        (self.case / "0.02" / "phi").unlink()
        summary, _ = cfd_case.analyse(self.case, TRANSIENT)
        self.assertIsNone(summary["flux_imbalance_percent"])
        self.assertIsNone(summary["steady_converged"])

    def test_rejects_unassigned_faces_after_mesh_conversion(self):
        self.fixture("200")
        path = self.case / "constant/polyMesh/boundary"
        path.write_text(self.stored("constant/polyMesh/boundary").replace("nFaces 0", "nFaces 1"))
        with self.assertRaisesRegex(ValueError, "할당되지 않은"):
            cfd_case.set_wall_type(self.case)

    def test_quad_patches_are_used_by_pressure_analysis(self):
        self.fixture("200")
        path = self.case / "constant/polyMesh"
        prefix = "FoamFile { format ascii; class IOList; }\n"
        (path / "points").write_text(prefix + "4((0 0 0)(2 0 0)(2 1 0)(0 1 0))", encoding="utf-8")
        (path / "faces").write_text(prefix + "7(" + "4(0 1 2 3)" * 7 + ")", encoding="utf-8")
        summary, _ = cfd_case.analyse(self.case, STEADY)
        self.assertEqual(summary["inlet_mesh_area_m2"], 4)
        self.assertEqual(summary["outlet_mesh_area_m2"], 2)
        self.assertEqual(summary["pressure_drop_pa"], 8)


if __name__ == "__main__":
    unittest.main()
