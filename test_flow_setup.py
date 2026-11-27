"""Verify solver readiness and the Windows handoff without invoking WSL."""

import subprocess
import unittest
from pathlib import PureWindowsPath
from types import SimpleNamespace
from unittest.mock import patch

import flow_setup


class RuntimeSetupTest(unittest.TestCase):
    def setUp(self):
        cache = patch.object(flow_setup, "_wsl_environment", None)
        cache.start()
        self.addCleanup(cache.stop)

    def test_wsl_probe_and_solver_command_when_gmsh_is_unavailable(self):
        wsl = r"C:\Windows\System32\wsl.exe"
        commands = {name: f"/opt/openfoam14/platforms/bin/{name}" for name in flow_setup.COMMANDS}
        results = [
            subprocess.CompletedProcess([], 0, stdout="Ubuntu\r\n".encode("utf-16-le")),
            subprocess.CompletedProcess([], 0, stdout=("\n".join(commands.values()) + "\ngpu-pressure-ready\n").encode()),
        ]
        with (
            patch.object(flow_setup, "os", SimpleNamespace(name="nt", environ={})),
            patch.object(flow_setup.shutil, "which", side_effect=lambda name: wsl if name == "wsl.exe" else None),
            patch.object(flow_setup, "gmsh_available", return_value=False),
            patch.object(flow_setup.subprocess, "run", side_effect=results) as probe,
        ):
            env = flow_setup.environment(demo=False)
            self.assertEqual(flow_setup.environment(demo=False), env)
            case = PureWindowsPath(r"C:\CFD Cases\한글 경로")
            argv = flow_setup.solver_command(env, case, "gmshToFoam", "domain.msh")
        self.assertEqual(env["solver_backend"], "wsl")
        self.assertTrue(env["solver_ready"])
        self.assertTrue(env["gpu_pressure_ready"])
        self.assertFalse(env["ready"])
        self.assertEqual(env["commands"], commands)
        self.assertEqual(probe.call_count, 2)
        self.assertEqual(probe.call_args_list[0].args[0], [wsl, "--list", "--quiet"])
        self.assertEqual(probe.call_args_list[1].args[0][-4:], list(flow_setup.COMMANDS))
        self.assertEqual(argv[:6], [wsl, "--cd", "/", "--exec", "bash", "-c"])
        self.assertEqual(argv[-3:], [str(case), commands["gmshToFoam"], "domain.msh"])

    def test_no_registered_distribution_skips_the_linux_command(self):
        with (
            patch.object(flow_setup.shutil, "which", return_value="wsl.exe"),
            patch.object(flow_setup.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, stdout=b"")) as probe,
        ):
            self.assertIsNone(flow_setup.wsl_solver())
        probe.assert_called_once()

    def test_adaptive_step_count_caps_delta_and_accepts_intermediate_flow_change(self):
        body = dict(mode="transient", fluid="water", rho=998, mu=0.001, inlet_speed_m_s=0.2,
                    outlet_pressure_pa=0, end_time_s=0.01, step_count=10,
                    flow_schedule=[{"time_s": 0.0035, "ml_min": 12}])
        adaptive = flow_setup.parse_conditions(dict(body, time_step_mode="adaptive"))
        self.assertEqual(adaptive["requested_step_count"], 10)
        self.assertEqual(adaptive["time_step_s"], 0.001)
        self.assertNotIn("step_count", adaptive)
        with self.assertRaisesRegex(ValueError, "유량 변경 시각"):
            flow_setup.parse_conditions(dict(body, time_step_mode="fixed"))
        restored = flow_setup.apply_conditions(adaptive, {"end_time_s": 0.02})
        self.assertEqual(restored["time_step_s"], 0.002)
        fixed = flow_setup.apply_conditions(adaptive, {"time_step_mode": "fixed", "step_count": 20,
                                                       "flow_schedule": []})
        self.assertEqual(fixed["step_count"], 20)
        self.assertNotIn("requested_step_count", fixed)
