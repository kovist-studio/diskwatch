# DiskWatch — Windows audit probe.
# Paste this whole block into a NON-ELEVATED PowerShell window.
# It only reads. It changes nothing, installs nothing, and never asks for
# administrator rights: the refusals it collects are the point of running it.
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$script:log = New-Object System.Collections.ArrayList
function Say($t) { [void]$script:log.Add([string]$t); Write-Host $t }
function DumpErrors($errs) {
  $i = 0
  foreach ($e in $errs) {
    $i++
    Say ("  [$i] Category      : " + [string]$e.CategoryInfo.Category)
    Say ("      Reason        : " + [string]$e.CategoryInfo.Reason)
    Say ("      Activity      : " + [string]$e.CategoryInfo.Activity)
    Say ("      FQID          : " + [string]$e.FullyQualifiedErrorId)
    if ($e.Exception -ne $null) {
      Say ("      ExceptionType : " + $e.Exception.GetType().FullName)
      Say ("      HResult       : 0x" + ('{0:X8}' -f $e.Exception.HResult))
      Say ("      Message       : " + $e.Exception.Message)
    }
    Say ("      ToString      : " + ($e.ToString() -replace '\r?\n', ' | '))
  }
  if ($i -eq 0) { Say '  (none)' }
}
function RunCheck($name, $block, $probe) {
  Say ''
  Say ('===== CHECK: ' + $name + ' =====')
  $Error.Clear()
  $data = $null
  try { $data = & $block } catch { }
  $errs = @($Error)
  $norm = New-Object System.Collections.ArrayList
  foreach ($e in $errs) {
    [void]$norm.Add([pscustomobject]@{
      category  = [string]$e.CategoryInfo.Category
      fqid      = [string]$e.FullyQualifiedErrorId
      exception = $(if ($e.Exception -ne $null) { [string]$e.Exception.GetType().FullName } else { '' })
      message   = $(if ($e.Exception -ne $null) { [string]$e.Exception.Message } else { '' })
    })
  }
  $envelope = [pscustomobject]@{ data = $data; errors = @($norm) }
  Say '--- envelope (exactly what DiskWatch parses) ---'
  Say ($envelope | ConvertTo-Json -Compress -Depth 6)
  Say '--- raw errors, verbatim (newest first, as PowerShell stores them) ---'
  DumpErrors $errs
  Say '--- property types (the assumptions being checked) ---'
  $Error.Clear()
  if ($probe -ne $null) { try { & $probe } catch { Say ('      probe failed: ' + $_.Exception.GetType().FullName) } }
  $Error.Clear()
}
Say '########## DiskWatch Windows audit probe ##########'
Say ('PSVersion     : ' + $PSVersionTable.PSVersion.ToString())
Say ('PSEdition     : ' + [string]$PSVersionTable.PSEdition)
Say ('OS            : ' + [string][System.Environment]::OSVersion.VersionString)
Say ('Culture       : ' + (Get-Culture).Name + '  UICulture: ' + (Get-UICulture).Name)
Say ('Elevated      : ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
Say ('OutputEncoding: ' + [Console]::OutputEncoding.WebName)
RunCheck 'defender' {
  $s = Get-MpComputerStatus
  if ($s -ne $null) {
    [pscustomobject]@{
      antivirusEnabled = [bool]$s.AntivirusEnabled
      realtimeEnabled  = [bool]$s.RealTimeProtectionEnabled
      signatureAgeDays = [int]$s.AntivirusSignatureAge
      signatureUpdated = $(if ($s.AntivirusSignatureLastUpdated -ne $null) { $s.AntivirusSignatureLastUpdated.ToUniversalTime().ToString('o') } else { $null })
    }
  }
} {
  $s = Get-MpComputerStatus
  if ($s -ne $null) {
    Say ('      AntivirusEnabled          : ' + $s.AntivirusEnabled.GetType().FullName + ' = ' + [string]$s.AntivirusEnabled)
    Say ('      RealTimeProtectionEnabled : ' + $s.RealTimeProtectionEnabled.GetType().FullName + ' = ' + [string]$s.RealTimeProtectionEnabled)
    Say ('      AntivirusSignatureAge     : ' + $s.AntivirusSignatureAge.GetType().FullName + ' = ' + [string]$s.AntivirusSignatureAge)
    Say ('      SignatureLastUpdated      : ' + $(if ($s.AntivirusSignatureLastUpdated -ne $null) { $s.AntivirusSignatureLastUpdated.GetType().FullName } else { 'null' }))
  } else { Say '      (Get-MpComputerStatus returned nothing)' }
}
RunCheck 'firewall' {
  @(Get-NetFirewallProfile | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; enabled = [string]$_.Enabled } })
} {
  $p = @(Get-NetFirewallProfile)
  Say ('      profile count : ' + $p.Count)
  if ($p.Count -gt 0) {
    Say ('      Name type     : ' + $p[0].Name.GetType().FullName)
    Say ('      Enabled type  : ' + $p[0].Enabled.GetType().FullName)
    Say ('      Enabled value : [string] gives "' + [string]$p[0].Enabled + '", [int] gives ' + [int]$p[0].Enabled)
    Say ('      Enum names    : ' + ([Enum]::GetNames($p[0].Enabled.GetType()) -join ', '))
  }
}
RunCheck 'disks' {
  @(Get-PhysicalDisk | ForEach-Object { [pscustomobject]@{ name = [string]$_.FriendlyName; health = [string]$_.HealthStatus; media = [string]$_.MediaType } })
} {
  $d = @(Get-PhysicalDisk)
  Say ('      disk count    : ' + $d.Count)
  if ($d.Count -gt 0) {
    Say ('      HealthStatus  : ' + $d[0].HealthStatus.GetType().FullName + ' -> "' + [string]$d[0].HealthStatus + '"')
    Say ('      MediaType     : ' + $d[0].MediaType.GetType().FullName + ' -> "' + [string]$d[0].MediaType + '"')
    Say ('      FriendlyName  : ' + $d[0].FriendlyName.GetType().FullName)
  }
}
RunCheck 'bitlocker' {
  @(Get-BitLockerVolume | ForEach-Object { [pscustomobject]@{ mount = [string]$_.MountPoint; status = [string]$_.VolumeStatus; protection = [string]$_.ProtectionStatus } })
} {
  $Error.Clear()
  $v = @(Get-BitLockerVolume)
  Say ('      volume count  : ' + $v.Count)
  Say ('      errors raised while probing : ' + $Error.Count)
  if ($v.Count -gt 0) {
    Say ('      VolumeStatus    : ' + $v[0].VolumeStatus.GetType().FullName + ' -> "' + [string]$v[0].VolumeStatus + '"')
    Say ('      ProtectionStatus: ' + $v[0].ProtectionStatus.GetType().FullName + ' -> "' + [string]$v[0].ProtectionStatus + '"')
  }
}
RunCheck 'secureboot' {
  $v = Confirm-SecureBootUEFI
  if ($v -ne $null) { [pscustomobject]@{ enabled = [bool]$v } }
} {
  Say '      (no probe: the cmdlet either answers or refuses)'
}
Say ''
Say '########## end ##########'
$dest = Join-Path $env:TEMP 'diskwatch-windows-audit.txt'
try {
  $script:log -join "`r`n" | Out-File -FilePath $dest -Encoding utf8
  Write-Host ''
  Write-Host ('Saved a copy to: ' + $dest) -ForegroundColor Green
} catch { Write-Host 'Could not save a copy; the output above is complete.' }
