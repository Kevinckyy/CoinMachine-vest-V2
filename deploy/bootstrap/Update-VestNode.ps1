#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidatePattern('^[0-9a-f]{40}$')][string]$Revision,
    [ValidateRange(1,3600)][int]$WaitSeconds=180,
    [string]$Root=(Join-Path $env:LOCALAPPDATA 'VestFleet')
)
$ErrorActionPreference='Stop'
$pin=Join-Path $PSScriptRoot 'release.json'
if (!$Revision) {
    if (!(Test-Path -LiteralPath $pin)) { throw 'Supply -Revision with the SHA requested by the center.' }
    $Revision=(Get-Content -Raw -Encoding UTF8 $pin | ConvertFrom-Json).revision
}
$cfg=@{}
foreach ($line in Get-Content -Encoding UTF8 (Join-Path $Root 'bridge.env')) {
    if ($line -cmatch '^(VEST_NODE_ID|VEST_NODE_TOKEN)=(.+)$') { $cfg[$Matches[1]]=$Matches[2] }
}
if (!$cfg.VEST_NODE_ID -or !$cfg.VEST_NODE_TOKEN) { throw 'Missing installed node credentials' }
$task=Get-ScheduledTask -TaskName ('VestFleet.Node.'+$cfg.VEST_NODE_ID)
if ($task.State -ne 'Running') { Start-ScheduledTask -InputObject $task }
$until=(Get-Date).AddSeconds($WaitSeconds)
$last=''
do {
    try {
        $s=Invoke-RestMethod 'http://127.0.0.1:8877/v1/status' -Headers @{Authorization='Bearer '+$cfg.VEST_NODE_TOKEN} -TimeoutSec 4
    } catch {
        $s=$null
        if ($last -ne 'Waiting for the local bridge') { $last='Waiting for the local bridge'; Write-Host $last }
    }
    if ($s) {
        if ($s.node_id -cne $cfg.VEST_NODE_ID) { throw 'Unexpected local bridge identity' }
        $cutoff=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-25
        $online=@($s.workers | Where-Object { $_.last_seen -gt $cutoff })
        $confirmed=@($online | Where-Object { $_.release -ceq $Revision })
        $status="Bridge $($s.release); online browsers on target: $($confirmed.Count)/$($online.Count)"
        if ($status -cne $last) { Write-Host $status; $last=$status }
        if ($s.release -ceq $Revision -and $online.Count -gt 0 -and $confirmed.Count -eq $online.Count) {
            $confirmed | Select-Object label,plugin_version,release
            exit 0
        }
    }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $until)
Write-Warning "Target $Revision is still unconfirmed locally. Check the job on the center and node-state\agent.log."
exit 2
