"""Exercise the local server with generated cases, without requiring OpenFOAM."""

import csv
import io
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


APP = Path(__file__).resolve().with_name("app.py")


@contextmanager
def running_server(runs_dir, *, demo=False):
    args = [sys.executable, str(APP), "--port", "0", "--runs-dir", str(runs_dir)]
    if demo:
        args.append("--demo")
    environment = os.environ.copy()
    environment.pop("WM_PROJECT_VERSION", None)

    startup = queue.Queue(maxsize=1)
    with tempfile.TemporaryFile(mode="w+b") as stderr:
        with subprocess.Popen(
            args, cwd=APP.parent, env=environment, stdout=subprocess.PIPE,
            stderr=stderr, text=True, encoding="utf-8", errors="replace",
        ) as process:
            threading.Thread(target=lambda: startup.put(process.stdout.readline()), daemon=True).start()
            try:
                try:
                    line = startup.get(timeout=10)
                except queue.Empty:
                    line = ""
                match = re.search(r"http://127\.0\.0\.1:\d+/", line)
                if not match:
                    stderr.seek(0)
                    stdio_error = stderr.read().decode("utf-8", errors="replace")
                    raise AssertionError(f"Server did not print its local URL: {line!r}\n{stdio_error}")
                yield match[0].rstrip("/")
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)


def get_json(server, route, *, data=None):
    request = Request(server + route, data=data, headers={"Content-Type": "application/json"})
    try:
        response = urlopen(request, timeout=5)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response)


def start_run(server, ny):
    return get_json(server, "/api/runs", data=json.dumps({"ny": ny}).encode("utf-8"))


def await_terminal_run(server, run_id):
    route = f"/api/runs/{run_id}"
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        status, run = get_json(server, route)
        if status != 200:
            raise AssertionError(f"Run {run_id} returned HTTP {status}: {run}")
        if run["status"] in {"complete", "failed"}:
            return run
        time.sleep(0.05)
    raise AssertionError(f"Run {run_id} did not reach a terminal state")


class AppIntegrationTest(unittest.TestCase):
    def test_demo_runs_generate_results_and_survive_restart(self):
        with tempfile.TemporaryDirectory(prefix="openfoam-app-test-") as temporary:
            runs_dir = Path(temporary)
            ids = set()
            with running_server(runs_dir, demo=True) as server:
                status, environment = get_json(server, "/api/environment")
                self.assertEqual(status, 200)
                self.assertIs(environment["demo"], True)

                for ny in (20, 40, 80, 20):
                    with self.subTest(ny=ny):
                        status, accepted = start_run(server, ny)
                        self.assertEqual(status, 202, accepted)
                        run_id = accepted["id"]
                        self.assertNotIn(run_id, ids)
                        ids.add(run_id)

                        result = await_terminal_run(server, run_id)
                        self.assertEqual(result["status"], "complete", result)
                        self.assertIs(result["demo"], True)
                        self.assertEqual(result["ny"], ny)
                        self.assertIsNone(result["error"])

                        summary = result["summary"]
                        self.assertEqual(summary["cells"], 10 * ny * ny)
                        self.assertAlmostEqual(summary["tap_b_x_m"] - summary["tap_a_x_m"], 0.010)
                        self.assertAlmostEqual(summary["tap_dp_exact_Pa"], 2.16, places=9)
                        self.assertAlmostEqual(summary["tap_dp_Pa"], 2.1816, places=9)
                        self.assertAlmostEqual(
                            summary["tap_dp_error_percent"],
                            100 * abs(summary["tap_dp_Pa"] - 2.16) / 2.16,
                            places=8,
                        )
                        self.assertAlmostEqual(summary["centre_section_Ux_profile_relative_L2_percent"], 1)
                        self.assertIsNone(summary["boundary_flux_imbalance_percent"])

                        profile = result["profile"]
                        self.assertEqual(len(profile), ny)
                        for index, row in enumerate(profile):
                            eta = (index + 0.5) / ny
                            self.assertAlmostEqual(float(row["y_over_H"]), eta)
                            self.assertAlmostEqual(float(row["Ux_exact_at_centre_m_s"]), 6 * eta * (1 - eta))
                            self.assertAlmostEqual(float(row["Ux_CFD_m_s"]), 0.99 * 6 * eta * (1 - eta))
                        with urlopen(f"{server}/api/runs/{run_id}/profile.csv", timeout=5) as response:
                            self.assertEqual(response.headers.get_content_type(), "text/csv")
                            self.assertIn("attachment", response.headers.get("Content-Disposition", ""))
                            download = list(csv.DictReader(io.StringIO(response.read().decode("utf-8-sig"))))
                        self.assertEqual(len(download), ny)
                        for downloaded, row in zip(download, profile):
                            for field in ("y_over_H", "Ux_CFD_m_s", "Ux_exact_at_centre_m_s"):
                                self.assertAlmostEqual(float(downloaded[field]), float(row[field]))

                status, listing = get_json(server, "/api/runs")
                self.assertEqual(status, 200)
                self.assertEqual({row["id"] for row in listing["runs"]}, ids)

            with running_server(runs_dir) as server:
                status, listing = get_json(server, "/api/runs")
                self.assertEqual(status, 200)
                self.assertEqual({row["id"] for row in listing["runs"]}, ids)
                for run_id in ids:
                    status, result = get_json(server, f"/api/runs/{run_id}")
                    self.assertEqual(status, 200)
                    self.assertEqual(result["status"], "complete")
                    self.assertIs(result["demo"], True)
                    self.assertAlmostEqual(result["summary"]["tap_dp_exact_Pa"], 2.16)

    def test_missing_openfoam_reports_environment_failure(self):
        with tempfile.TemporaryDirectory(prefix="openfoam-app-test-") as temporary:
            runs_dir = Path(temporary)
            with running_server(runs_dir) as server:
                status, environment = get_json(server, "/api/environment")
                self.assertEqual(status, 200)
                self.assertIs(environment["ready"], False)
                self.assertIs(environment["demo"], False)
                self.assertTrue(environment["problems"])
                self.assertEqual(
                    set(environment["commands"]),
                    {"blockMesh", "checkMesh", "foamRun", "foamPostProcess", "python3", "sh"},
                )

                status, accepted = start_run(server, 20)
                self.assertEqual(status, 202, accepted)
                run_id = accepted["id"]
                result = await_terminal_run(server, run_id)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["stage"], "environment")
                self.assertTrue(result["error"])
                self.assertIsNone(result["summary"])
                self.assertIsNone(result["profile"])
                self.assertTrue(result["logs"])
                for filename in result["logs"]:
                    status, log = get_json(server, f"/api/runs/{run_id}/logs/{filename}")
                    self.assertEqual(status, 200)
                    self.assertTrue(log["text"].strip())
                    self.assertIs(log["truncated"], False)

                with (runs_dir / run_id / "log.Allrun").open("a", encoding="utf-8") as output:
                    output.write("head of synthetic log\n" + "x" * (70 * 1024) + "\nlast line\n")
                status, log = get_json(server, f"/api/runs/{run_id}/logs/log.Allrun")
                self.assertEqual(status, 200)
                self.assertIs(log["truncated"], True)
                self.assertNotIn("head of synthetic log", log["text"])
                self.assertEqual(log["text"].splitlines()[-1], "last line")

                cases = list(runs_dir.rglob("benchmark.json"))
                self.assertEqual(len(cases), 1)
                input_spec = json.loads(cases[0].read_text(encoding="utf-8"))
                self.assertEqual((input_spec["nx"], input_spec["ny"]), (200, 20))
                with self.assertRaises(HTTPError) as unavailable:
                    urlopen(f"{server}/api/runs/{run_id}/profile.csv", timeout=5)
                self.assertEqual(unavailable.exception.code, 404)

            with running_server(runs_dir) as server:
                status, result = get_json(server, f"/api/runs/{run_id}")
                self.assertEqual(status, 200)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["stage"], "environment")

    def test_invalid_mesh_requests_do_not_start_runs(self):
        with tempfile.TemporaryDirectory(prefix="openfoam-app-test-") as temporary:
            with running_server(Path(temporary), demo=True) as server:
                for invalid in (0, 30, 100, "20", True, None):
                    with self.subTest(ny=invalid):
                        status, error = start_run(server, invalid)
                        self.assertEqual(status, 400, error)
                status, _ = get_json(server, "/api/runs", data=b"{invalid")
                self.assertEqual(status, 400)
                status, listing = get_json(server, "/api/runs")
                self.assertEqual(status, 200)
                self.assertEqual(listing["runs"], [])


if __name__ == "__main__":
    unittest.main()
