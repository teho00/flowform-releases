$ErrorActionPreference = 'Stop'
$distro = 'Ubuntu-24.04'
$wsl = Join-Path $env:WINDIR 'System32\wsl.exe'
$profileDir = Join-Path $env:LOCALAPPDATA 'FlowFormInstalled'

function Get-WslDistributions {
    $ErrorActionPreference = 'Continue'
    $output = & $wsl --list --quiet 2>$null
    $output | ForEach-Object { ($_ -replace '\x00','').Trim() }
}

try {
    if (-not (Test-Path -LiteralPath $wsl)) {
        throw 'WSL is unavailable. Install WSL 2 from https://learn.microsoft.com/windows/wsl/install, then run this helper again.'
    }

    if ((Get-WslDistributions) -notcontains $distro) {
        Write-Host 'Installing Ubuntu 24.04 in WSL. Connect to the Internet.'
        & $wsl --install --distribution $distro --no-launch
        if ((Get-WslDistributions) -notcontains $distro) {
            throw 'Install WSL from an administrator terminal (wsl --install --no-distribution), reboot if requested, then run this helper again.'
        }
    }

    Write-Host 'Installing or checking OpenFOAM Foundation v14 in Ubuntu 24.04.'
    $scriptPath = Join-Path $PSScriptRoot 'install-openfoam.sh'
    $linuxPath = & $wsl --distribution $distro --cd / --exec wslpath -a $scriptPath
    if ($LASTEXITCODE -ne 0 -or -not $linuxPath) { throw 'Could not locate the Ubuntu setup script.' }
    $output = & $wsl --distribution $distro --user root --cd / --exec /bin/bash $linuxPath.Trim()
    $exit = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    if ($exit -ne 0 -or $output -notcontains 'FLOWFORM_OPENFOAM14_READY') {
        throw 'Could not confirm OpenFOAM. If Ubuntu shows first-time setup, open Ubuntu once, finish setup, and rerun this helper.'
    }

    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $profileDir 'openfoam14-cpu.ready') -Value 'Verified Ubuntu-24.04 OpenFOAM 14' -Encoding ascii
    Write-Host 'OpenFOAM v14 is ready. Reopen the FlowForm CFD screen.'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    Read-Host 'Press Enter to close' | Out-Null
}

