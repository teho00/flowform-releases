#!/usr/bin/env bash
set -e -o pipefail
. /etc/os-release
if [ "$ID" != ubuntu ] || [ "$VERSION_ID" != 24.04 ] || [ "$(dpkg --print-architecture)" != amd64 ]; then
    echo "Requires Ubuntu 24.04 amd64." >&2
    exit 1
fi
if [ ! -r /opt/openfoam14/etc/bashrc ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates wget
    if ! grep -Rqs 'dl.openfoam.org/ubuntu' /etc/apt/sources.list /etc/apt/sources.list.d; then
        install -d -m 755 /etc/apt/keyrings
        wget -O /etc/apt/keyrings/flowform-openfoam.asc https://dl.openfoam.org/gpg.key
        chmod 644 /etc/apt/keyrings/flowform-openfoam.asc
        printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/flowform-openfoam.asc] http://dl.openfoam.org/ubuntu noble main' \
            > /etc/apt/sources.list.d/flowform-openfoam.list
    fi
    apt-get update
    apt-get install -y openfoam14
fi
. /opt/openfoam14/etc/bashrc >/dev/null
[ "$WM_PROJECT_VERSION" = 14 ]
for tool in gmshToFoam checkMesh foamRun foamPostProcess; do
    path=$(command -v "$tool")
    [ "$path" = "/opt/openfoam14/platforms/linux64GccDPInt32Opt/bin/$tool" ]
done
echo FLOWFORM_OPENFOAM14_READY

