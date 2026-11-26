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
