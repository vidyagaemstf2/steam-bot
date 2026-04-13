#Requires -Version 5.1
<#
  Creates or starts a persistent MySQL 8.4 container for local development.

  - Named volume vidya-mysql-data stores data across container recreation.
  - Container vidya-mysql uses --restart unless-stopped (starts when Podman comes up).
  - Copy podman-mysql.env.example -> podman-mysql.env to override defaults (gitignored).

  Usage: pwsh -File scripts/podman-mysql.ps1
#>

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir 'podman-mysql.env'

if (Test-Path $EnvFile) {
  Get-Content $EnvFile | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*#' } | ForEach-Object {
    $pair = $_.Split('=', 2)
    if ($pair.Count -eq 2) {
      Set-Item -Path "env:$($pair[0].Trim())" -Value $pair[1].Trim()
    }
  }
}

if (-not $env:MYSQL_PORT) {
  $env:MYSQL_PORT = '3306'
}
if (-not $env:MYSQL_ROOT_PASSWORD) {
  $env:MYSQL_ROOT_PASSWORD = 'devroot'
}
if (-not $env:MYSQL_DATABASE) {
  $env:MYSQL_DATABASE = 'vidya'
}
if (-not $env:MYSQL_USER) {
  $env:MYSQL_USER = 'vidya'
}
if (-not $env:MYSQL_PASSWORD) {
  $env:MYSQL_PASSWORD = 'vidya'
}

$ContainerName = 'vidya-mysql'
$VolumeName = 'vidya-mysql-data'
$Image = 'docker.io/mysql:8.4'

Write-Host "Ensuring Podman volume $VolumeName..."
& podman volume inspect $VolumeName 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  & podman volume create $VolumeName
}

& podman container exists $ContainerName 2>$null | Out-Null
$containerExists = $LASTEXITCODE -eq 0

if ($containerExists) {
  $running = (& podman inspect -f '{{.State.Running}}' $ContainerName 2>$null).Trim()
  if ($running -eq 'true') {
    Write-Host "Container $ContainerName is already running."
  } else {
    Write-Host "Starting existing container $ContainerName..."
    & podman start $ContainerName
  }
} else {
  Write-Host "Creating container $ContainerName (restart unless-stopped, data in volume $VolumeName)..."
  & podman run -d `
    --name $ContainerName `
    --restart unless-stopped `
    -p "$($env:MYSQL_PORT):3306" `
    -v "${VolumeName}:/var/lib/mysql" `
    -e "MYSQL_ROOT_PASSWORD=$($env:MYSQL_ROOT_PASSWORD)" `
    -e "MYSQL_DATABASE=$($env:MYSQL_DATABASE)" `
    -e "MYSQL_USER=$($env:MYSQL_USER)" `
    -e "MYSQL_PASSWORD=$($env:MYSQL_PASSWORD)" `
    $Image
}

Write-Host ""
Write-Host "Use this in your project .env DATABASE_URL (dev only):"
$encUser = [uri]::EscapeDataString($env:MYSQL_USER)
$encPass = [uri]::EscapeDataString($env:MYSQL_PASSWORD)
Write-Host "DATABASE_URL=mysql://${encUser}:${encPass}@127.0.0.1:$($env:MYSQL_PORT)/$($env:MYSQL_DATABASE)"
Write-Host ""
Write-Host "Optional: mysql -h 127.0.0.1 -P $($env:MYSQL_PORT) -u $($env:MYSQL_USER) -p"
