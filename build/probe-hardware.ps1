<#
  Nimbus hardware probe.

  Reports facts only -- what CPU, how much RAM, which display adapters and how
  much video memory each one really has. It deliberately does NOT decide which
  transcription build to install; that judgement lives in src/hardware.js so
  there is one copy of it, shared by the installer and the app.

  Run twice in a product's life: once by the installer (elevated, so the
  registry read below sees every adapter's memory), and again on first launch,
  which is what catches a GPU swapped in after install.

  Usage:  powershell -ExecutionPolicy Bypass -File probe-hardware.ps1 -Out <file>
  Writes UTF-8 JSON to -Out, and to stdout when -Out is omitted.
  Always exits 0: a missing probe must degrade to the CPU build, never fail an
  install.
#>

param(
  [string]$Out = ''
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-VendorFromId {
  param([string]$id)
  if ($id -match 'VEN_10DE') { return 'nvidia' }
  if ($id -match 'VEN_1002|VEN_1022') { return 'amd' }
  if ($id -match 'VEN_8086') { return 'intel' }
  if ($id -match 'VEN_1414') { return 'microsoft' }   # Basic Render / RDP adapters
  if ($id -match 'VEN_13B5') { return 'arm' }
  if ($id -match 'VEN_5333|VEN_15AD|VEN_80EE') { return 'virtual' }
  return 'unknown'
}

<#
  Win32_VideoController.AdapterRAM is a signed 32-bit field, so anything past
  4 GB wraps or clamps and a 24 GB card reports 4095 MB. The driver's own
  qwMemorySize value is 64-bit and correct, so it wins whenever it is readable.
#>
function Get-VramBytes {
  param([string]$pnp, [long]$adapterRam)
  $best = 0
  $root = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
  foreach ($k in (Get-ChildItem $root | Where-Object { $_.PSChildName -match '^\d{4}$' })) {
    $p = Get-ItemProperty -Path $k.PSPath
    if (-not $p) { continue }
    if ($pnp -and $p.MatchingDeviceId) {
      $needle = ($p.MatchingDeviceId -replace '\\', '\')
      if ($pnp.ToLower().Replace('\', '') -notlike ('*' + $needle.ToLower().Replace('\', '') + '*')) { continue }
    }
    $q = $p.'HardwareInformation.qwMemorySize'
    if ($q -is [byte[]]) { $q = [System.BitConverter]::ToInt64($q, 0) }
    if ($q -and $q -gt $best) { $best = [long]$q }
  }
  if ($best -le 0 -and $adapterRam -gt 0) { $best = $adapterRam }
  return $best
}

$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem

$elevated = $false
try {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $elevated = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { $elevated = $false }

$cpuVendor = 'unknown'
if ($cpu) {
  if ($cpu.Manufacturer -match 'AMD|Authentic') { $cpuVendor = 'amd' }
  elseif ($cpu.Manufacturer -match 'Intel|Genuine') { $cpuVendor = 'intel' }
  elseif ($cpu.Manufacturer -match 'Qualcomm|ARM') { $cpuVendor = 'arm' }
}

$gpus = @()
foreach ($g in (Get-CimInstance Win32_VideoController)) {
  $vendor = Get-VendorFromId $g.PNPDeviceID
  if ($vendor -eq 'unknown' -and $g.AdapterCompatibility) {
    if ($g.AdapterCompatibility -match 'NVIDIA') { $vendor = 'nvidia' }
    elseif ($g.AdapterCompatibility -match 'Advanced Micro|AMD|ATI') { $vendor = 'amd' }
    elseif ($g.AdapterCompatibility -match 'Intel') { $vendor = 'intel' }
  }
  $ram = 0
  if ($g.AdapterRAM) { $ram = [long]$g.AdapterRAM }
  $vram = Get-VramBytes $g.PNPDeviceID $ram
  $gpus += [ordered]@{
    name        = [string]$g.Name
    vendor      = $vendor
    vramBytes   = [long]$vram
    driver      = [string]$g.DriverVersion
    driverDate  = [string]$g.DriverDate
    pnp         = [string]$g.PNPDeviceID
    status      = [string]$g.Status
  }
}

$ramBytes = 0
if ($cs -and $cs.TotalPhysicalMemory) { $ramBytes = [long]$cs.TotalPhysicalMemory }
elseif ($os -and $os.TotalVisibleMemorySize) { $ramBytes = [long]$os.TotalVisibleMemorySize * 1024 }

$report = [ordered]@{
  schema    = 1
  ts        = [int][double]::Parse((Get-Date -UFormat %s))
  source    = 'powershell'
  elevated  = $elevated
  os        = 'win32'
  osCaption = [string]$os.Caption
  osBuild   = [string]$os.BuildNumber
  arch      = [string]$env:PROCESSOR_ARCHITECTURE
  ramBytes  = $ramBytes
  cpu       = [ordered]@{
    name    = [string]$cpu.Name
    vendor  = $cpuVendor
    cores   = [int]$cpu.NumberOfCores
    threads = [int]$cpu.NumberOfLogicalProcessors
  }
  gpus      = $gpus
}

$json = $report | ConvertTo-Json -Depth 5

if ($Out) {
  try {
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
} else {
  Write-Output $json
}

exit 0
