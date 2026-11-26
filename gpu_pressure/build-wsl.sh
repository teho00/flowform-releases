#!/usr/bin/env bash
set -eo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
if [[ "$#" != 1 ]]; then
    echo "Pass the directory containing the pinned Linux CUDA wheels." >&2
    exit 1
fi
wheels="$1"
source /opt/openfoam14/etc/bashrc
if [[ "$WM_PROJECT_VERSION" != 14 || "$WM_OPTIONS" != linux64GccDPInt32Opt ]]; then
    echo "Requires OpenFOAM Foundation 14, linux64GccDPInt32Opt." >&2
    exit 1
fi

root="$HOME/.local/share/flowform-gpu"
export FLOWFORM_CUDA="$root/cuda"
mkdir -p "$FLOWFORM_CUDA" "$root/build/Make"
python3 - "$wheels" "$FLOWFORM_CUDA" <<'PY'
from pathlib import Path
from shutil import copyfileobj
import sys
import zipfile

wheels, target = map(Path, sys.argv[1:])
packages = (
    "nvidia_cudss_cu12-0.7.1.6-",
    "nvidia_cublas_cu12-12.9.3.13-",
    "nvidia_cuda_runtime_cu12-12.9.79-",
    "nvidia_cuda_nvcc_cu12-12.9.86-",
)
for package in packages:
    matches = list(wheels.glob(f"{package}*manylinux*x86_64.whl"))
    if len(matches) != 1:
        raise SystemExit(f"Expected exactly one Linux x86_64 wheel for {package}")
    with zipfile.ZipFile(matches[0]) as archive:
        for name in archive.namelist():
            parts = Path(name).parts
            if len(parts) < 4 or parts[0] != "nvidia" or parts[2] not in ("include", "lib") or name.endswith("/"):
                continue
            relative = Path(*parts[2:])
            if ".." in relative.parts:
                raise ValueError("Invalid path in CUDA archive")
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(name) as source, destination.open("wb") as output:
                copyfileobj(source, output)
PY

cp "$here/FlowFormCuDSS.C" "$root/build/"
cp "$here/Make/files" "$here/Make/options" "$root/build/Make/"
cd "$root/build"
wmake libso
ldd "$FOAM_USER_LIBBIN/libflowformGpuPressure.so"

