"""Launch the per-user installed edition without a system Python."""
import os
from pathlib import Path
import runpy
import sys

install = Path(__file__).resolve().parent
profile = Path(os.environ.setdefault("FLOWFORM_PROFILE_DIR", str(Path(os.environ["LOCALAPPDATA"]) / "FlowFormInstalled")))
os.environ.setdefault("FLOWFORM_WSL_DISTRO", "Ubuntu-24.04")
os.environ["FLOWFORM_INSTALLED"] = "1"
sys.argv[1:1] = ["--port", "8876", "--runs-dir", str(profile / "runs")]
runpy.run_path(str(install / "desktop.py"), run_name="__main__")

