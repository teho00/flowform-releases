param(
    [Parameter(Mandatory)][string]$EmbeddedPythonZip,
    [Parameter(Mandatory)][string]$InnoCompiler,
    [Parameter(Mandatory)][string]$WebView2Bootstrapper,
    [Parameter(Mandatory)][string]$RuntimeEnv,
    [Parameter(Mandatory)][string]$BuildDirectory,
    [string]$Version = '0.1.0',
    [string]$ManifestUrl,
    [string]$UpdatePublicKey
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^(0|[1-9][0-9]{0,3})(\.(0|[1-9][0-9]{0,3})){2}$') {
    throw 'Use a three-component numeric version.'
}
if ([bool]$ManifestUrl -ne [bool]$UpdatePublicKey) {
    throw 'Supply both ManifestUrl and UpdatePublicKey, or leave both unset.'
}
if ($ManifestUrl) {
    $url = [uri]$ManifestUrl
    if (-not $url.IsAbsoluteUri -or $url.Scheme -ne 'https' -or $url.UserInfo -or $url.Fragment) {
        throw 'The update manifest must use HTTPS.'
    }
    if ([Convert]::FromBase64String($UpdatePublicKey).Length -ne 32) { throw 'Expected a 32-byte Ed25519 public key.' }
}
if (Test-Path -LiteralPath $BuildDirectory) { throw 'Use a fresh build directory.' }
$project = Split-Path -Parent $PSScriptRoot
$venv = (Resolve-Path -LiteralPath $RuntimeEnv).Path
$compiler = (Resolve-Path -LiteralPath $InnoCompiler).Path
$zip = (Resolve-Path -LiteralPath $EmbeddedPythonZip).Path
$bootstrap = (Resolve-Path -LiteralPath $WebView2Bootstrapper).Path
$signature = Get-AuthenticodeSignature -LiteralPath $bootstrap
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft') {
    throw 'The WebView2 bootstrapper must be signed by Microsoft.'
}
$buildRoot = (New-Item -ItemType Directory -Path $BuildDirectory).FullName
$app = Join-Path $buildRoot 'payload\app'
$runtime = Join-Path $buildRoot 'payload\runtime'
$packages = Join-Path $runtime 'Lib\site-packages'
$recipe = Join-Path $buildRoot 'source\installer'
New-Item -ItemType Directory -Force -Path $app,$runtime,$packages,$recipe | Out-Null
$modules = @('app.py','cad_model.py','cad_sketch_topology.py','cad_sketch.py','cfd_case.py','cfd_mesh.py',
             'cfd_sweep.py','flow_contours.py','flow_setup.py','mesh_preview.py','mesh_quality.py','desktop.py','demo_fields.py')
foreach ($file in $modules) { Copy-Item -LiteralPath (Join-Path $project $file) -Destination $app }
foreach ($folder in 'channel_ui','OpenFOAM14_channel','gpu_pressure') {
    Copy-Item -LiteralPath (Join-Path $project $folder) -Destination $app -Recurse
}
foreach ($file in 'installed_launch.py','update_client.py','setup-openfoam.ps1','install-openfoam.sh','설치안내.txt') {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $app
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'FlowForm.iss') -Destination $recipe
Copy-Item -LiteralPath (Join-Path $project 'LICENSE') -Destination $app
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'third-party') -Destination $app -Recurse
Copy-Item -LiteralPath $bootstrap -Destination (Join-Path $buildRoot 'payload\MicrosoftEdgeWebview2Setup.exe')
Expand-Archive -LiteralPath $zip -DestinationPath $runtime -Force
Get-ChildItem -LiteralPath (Join-Path $venv 'Lib\site-packages') |
    Where-Object { $_.Name -notmatch '^(pip($|-)|__pycache__$)' } |
    Copy-Item -Destination $packages -Recurse
Copy-Item -LiteralPath (Join-Path $venv 'Lib\gmsh-4.15.dll') -Destination (Join-Path $runtime 'Lib')
@('python312.zip','.','Lib\site-packages','..\app','import site') |
    Set-Content -LiteralPath (Join-Path $runtime 'python312._pth') -Encoding ascii
@{current_version=$Version;manifest_url=$ManifestUrl;public_key=$UpdatePublicKey} |
    ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $app 'update-release.json') -Encoding ascii
& (Join-Path $runtime 'python.exe') -c "import app,gmsh,numpy,webview,OCP,cryptography,update_client; assert app.cad_model.KERNEL_READY"
if ($LASTEXITCODE -ne 0) { throw 'Packaged runtime import failed.' }
& $compiler "/DReleaseVersion=$Version" (Join-Path $recipe 'FlowForm.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer build failed.' }
Get-Item -LiteralPath (Join-Path $buildRoot "dist\FlowForm-$Version-Windows-x64-Setup.exe")

