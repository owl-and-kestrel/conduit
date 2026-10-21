$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$DistDir = Join-Path $Root "dist/windows"
$PackageRoot = Join-Path $DistDir "Conduit-win-x64"
$ArchivePath = Join-Path $DistDir "Conduit-win-x64.zip"
$Mode = if ($args.Count -gt 0) { $args[0] } else { "" }

switch ($Mode) {
  "" {
    Push-Location $Root
    try {
      npm run build
    } finally {
      Pop-Location
    }
  }
  "--skip-build" {
    if (-not (Test-Path (Join-Path $Root "dist"))) {
      throw "dist does not exist. Run npm run build first."
    }
  }
  default {
    throw "Usage: package_windows.ps1 [--skip-build]"
  }
}

Remove-Item -Recurse -Force $PackageRoot, $ArchivePath -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $PackageRoot | Out-Null
New-Item -ItemType Directory -Force (Join-Path $PackageRoot "runtime") | Out-Null

# No devDependencies: the package must install from the public registry alone.
node (Join-Path $Root "script/packaged_package_json.mjs") (Join-Path $Root "package.json") (Join-Path $PackageRoot "package.json")
if ($LASTEXITCODE -ne 0) {
  throw "script/packaged_package_json.mjs failed with exit code $LASTEXITCODE"
}
New-Item -ItemType Directory -Force (Join-Path $PackageRoot "runtime/dist") | Out-Null
Copy-Item -Recurse (Join-Path $Root "dist/src") (Join-Path $PackageRoot "runtime/dist/src")
Copy-Item -Recurse (Join-Path $Root "dist/scripts") (Join-Path $PackageRoot "runtime/dist/scripts")
Copy-Item (Join-Path $Root "platforms/windows/*.ps1") $PackageRoot
Copy-Item (Join-Path $Root "platforms/desktop-shell-contract.md") (Join-Path $PackageRoot "desktop-shell-contract.md")
Copy-Item (Join-Path $Root "platforms/windows/README.md") (Join-Path $PackageRoot "platforms-windows.md")

@"
Conduit for Windows preview

Install:
1. Extract this archive.
2. Run npm install --omit=dev from the extracted directory.
3. Run Conduit-Control.ps1 to start the local control panel.
4. Run Conduit-Agent-Listener.ps1 for browser agent-loop transport.
5. Run Conduit-Clipboard-Daemon.ps1 for exact-envelope clipboard monitoring.

Report bugs:
- Run Conduit-Report-Bug.ps1 to open the redacted diagnostics view.
- Diagnostics preview excludes clipboard contents, request payloads, file
  contents, session nonces, API keys, environment variables, and secrets.

This preview is not a native tray app yet. The native shell must follow
desktop-shell-contract.md.
"@ | Set-Content -Encoding UTF8 (Join-Path $PackageRoot "README.txt")

Compress-Archive -Path $PackageRoot -DestinationPath $ArchivePath -Force

Write-Host "Created $ArchivePath"
