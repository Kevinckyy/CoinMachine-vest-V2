[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Revision,
    [Parameter(Mandatory)][string]$StateDir,
    [Parameter(Mandatory)][string]$Database,
    [Parameter(Mandatory)][string]$EnvFile,
    [string]$Python = 'python',
    [switch]$Ssh
)
$ErrorActionPreference = 'Stop'
$interpreter = (Get-Command $Python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$environmentFile = (Resolve-Path -LiteralPath $EnvFile).ProviderPath
$statePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StateDir)
$databasePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Database)
$found = Select-String -LiteralPath $environmentFile -Pattern '^\s*VEST_NODE_ID\s*=\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,79})\s*$'
if (@($found).Count -ne 1) { throw 'EnvFile must contain exactly one VEST_NODE_ID.' }
$taskName = 'VestFleet.Node.' + $found.Matches[0].Groups[1].Value
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw "The scheduled task $taskName already exists. Use the center for subsequent updates."
}
$agent = Join-Path $PSScriptRoot 'node_agent.py'
$initArgs = @($agent, 'init', '--state', $statePath, '--revision', $Revision)
if ($Ssh) { $initArgs += '--ssh' }
& $interpreter @initArgs
if ($LASTEXITCODE -ne 0) { throw 'Node bootstrap failed.' }
$serviceDir = Join-Path $statePath 'supervisor'
New-Item -ItemType Directory -Force -Path $serviceDir | Out-Null
Copy-Item -LiteralPath $agent -Destination $serviceDir -Force
$installed = Join-Path $serviceDir 'node_agent.py'
$windowless = Join-Path (Split-Path -Parent $interpreter) 'pythonw.exe'
$program = if (Test-Path -LiteralPath $windowless -PathType Leaf) { $windowless } else { $interpreter }
$arguments = '-Bu "{0}" run --state "{1}" --db "{2}" --env-file "{3}" --log-file "{4}"' -f $installed,$statePath.TrimEnd('\'),$databasePath,$environmentFile,(Join-Path $statePath 'agent.log')
$action = New-ScheduledTaskAction -Execute $program -Argument $arguments
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Started $taskName. Load the unpacked extension from $(Join-Path $statePath 'extension')."
