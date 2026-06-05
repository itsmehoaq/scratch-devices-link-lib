# Unblock Future Academy installer (Mark of the Web) after browser download.
param(
    [Parameter(Mandatory = $false)]
    [string] $Path = (Join-Path $PSScriptRoot "..\dist\FutureAcademy-*-x64-setup.exe")
)

$files = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
if (-not $files) {
    $files = Get-ChildItem -Path $Path -ErrorAction SilentlyContinue
}
if (-not $files) {
    Write-Error "No installer found at: $Path"
    exit 1
}

foreach ($f in $files) {
    Unblock-File -LiteralPath $f.FullName
    Write-Host "Unblocked: $($f.FullName)"
}

Write-Host "Run the installer; if SmartScreen appears use More info -> Run anyway."
