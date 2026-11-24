#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding(DefaultParameterSetName='SSH')]
param(
    [Parameter(Mandatory,ParameterSetName='File')][string]$Bundle,
    [Parameter(Mandatory,ParameterSetName='SSH')][ValidatePattern('^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*$')][string]$CenterSsh,
    [Parameter(Mandatory,ParameterSetName='SSH')][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')][string]$NodeId,
    [Parameter(Mandatory,ParameterSetName='SSH')][ipaddress]$PublicIP,
    [Parameter(ParameterSetName='SSH')][ValidateRange(1,65535)][int]$Port=8443,
    [Parameter(ParameterSetName='SSH')][ValidateRange(1,65535)][int]$SshPort=22,
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'VestFleet'),
    [ipaddress]$CenterSourceIP,
    [switch]$Ssh
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::UserInteractive) {
    throw 'Run from an interactive Windows Server x64 desktop as the browser user.'
}
$null = Get-Command git.exe -ErrorAction Stop
$Root = [IO.Path]::GetFullPath($Root)
$who = [Security.Principal.WindowsIdentity]::GetCurrent()
# Private enrollment, browser profile, keys and SQLite files all inherit this ACL.
if ((Test-Path -LiteralPath $Root) -and !(Test-Path -LiteralPath (Join-Path $Root '.vest-install')) -and
    @(Get-ChildItem -LiteralPath $Root -Force).Count) { throw 'Choose an empty or previously provisioned VestFleet folder.' }
$null = [IO.Directory]::CreateDirectory($Root)
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach ($sid in @($who.User, [Security.Principal.SecurityIdentifier]'S-1-5-18',
                   [Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
Set-Acl -LiteralPath $Root -AclObject $acl
[IO.File]::WriteAllText((Join-Path $Root '.vest-install'),'Vest Fleet')
$lock = [IO.File]::Open((Join-Path $Root 'install.lock'),'OpenOrCreate','ReadWrite','None')
$stage = Join-Path $Root ('setup-' + [guid]::NewGuid())
$null = [IO.Directory]::CreateDirectory($stage)

function Get-Download($Url,$Target) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Target -TimeoutSec 360
}
function Install-Zip($url,$target,$expectedFile,$digest) {
    if (Test-Path -LiteralPath (Join-Path $target $expectedFile) -PathType Leaf) { return }
    $archive = Join-Path $stage ('download-'+[guid]::NewGuid()+'.zip')
    Get-Download $url $archive
    if ($digest -and (Get-FileHash $archive -Algorithm SHA256).Hash -ne $digest) { throw "Checksum mismatch for $url" }
    $expanded = Join-Path $stage ([guid]::NewGuid().ToString())
    [IO.Compression.ZipFile]::ExtractToDirectory($archive,$expanded)
    if (!(Test-Path -LiteralPath (Join-Path $expanded $expectedFile) -PathType Leaf)) { throw "Missing $expectedFile in download" }
    [IO.Directory]::Move($expanded,$target)
}
function Start-LoginTask($name,$program,$arguments) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
        if ($existing.Actions[0].Execute -ne $program -or $existing.Actions[0].Arguments -ne $arguments) {
            throw "A different task already uses $name"
        }
        if ($existing.State -ne 'Running') { Start-ScheduledTask -TaskName $name }
        return
    }
    $action = New-ScheduledTaskAction -Execute $program -Argument $arguments -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $who.Name
    $principal = New-ScheduledTaskPrincipal -UserId $who.Name -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
    $null = Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings
    Start-ScheduledTask -TaskName $name
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'SSH') {
        if ($PublicIP.AddressFamily -ne 'InterNetwork') { throw 'IPv4 required' }
        $sshClient = Get-Command ssh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
        if (!$sshClient) {
            $gitRoot = Split-Path -Parent (Split-Path -Parent (Get-Command git.exe).Source)
            $sshClient = Join-Path $gitRoot 'usr\bin\ssh.exe'
        }
        $remote = "bash /opt/vest-fleet/bootstrap/center.sh bundle $NodeId $($PublicIP.IPAddressToString) $Port"
        if (!$CenterSsh.StartsWith('root@')) { $remote = 'sudo -n '+$remote }
        $packet = & $sshClient -T -p $SshPort -o StrictHostKeyChecking=ask $CenterSsh $remote
        $sshExit = $LASTEXITCODE
        if ($sshExit -eq 255) {
            throw ("SSH to $CenterSsh on TCP port $SshPort failed. See the SSH error above. For a timeout, check the SSH listener, -SshPort and inbound access from this node. " +
                   "To enroll via a file, run 'sudo bash /opt/vest-fleet/bootstrap/center.sh node $NodeId $($PublicIP.IPAddressToString) $Port' on the center, transfer the private ZIP, then run '.\node.ps1 -Bundle <path-to-zip>'.")
        }
        if ($sshExit -ne 0) { throw "The center enrollment command exited with code $sshExit. See its output above." }
        $bundlePath = Join-Path $stage 'node.zip'
        [IO.File]::WriteAllBytes($bundlePath,[Convert]::FromBase64String(($packet -join '')))
        $packet=$null
    } else {
        $bundlePath = (Resolve-Path -LiteralPath $Bundle).ProviderPath
    }
    $zip = [IO.Compression.ZipFile]::OpenRead($bundlePath)
    try {
        foreach ($file in @('setup.json','server.crt','server.key','center-root.crt','pair.js','Install-VestNode.ps1','node_agent.py')) {
            $entry = $zip.GetEntry($file)
            if (!$entry -or $entry.Length -gt 2MB) { throw "Invalid enrollment file: $file" }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $stage $file))
        }
    } finally { $zip.Dispose() }
    $cfg = Get-Content -Raw -Encoding UTF8 (Join-Path $stage 'setup.json') | ConvertFrom-Json
    $ip = [ipaddress]::Parse($cfg.ip)
    $center = [uri]$cfg.center
    if ($PSCmdlet.ParameterSetName -eq 'SSH' -and ($cfg.node -cne $NodeId -or !$ip.Equals($PublicIP) -or [int]$cfg.port -ne $Port)) {
        throw 'The enrollment does not match the requested node'
    }
    $port = [int]$cfg.port
    if ($cfg.node -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' -or $cfg.revision -cnotmatch '^[0-9a-f]{40}$' -or
        $cfg.node_token -cnotmatch '^[A-Za-z0-9_-]{24,128}$' -or $cfg.plugin_token -cnotmatch '^[A-Za-z0-9_-]{24,128}$' -or
        $cfg.node_token -eq $cfg.plugin_token -or $ip.AddressFamily -ne 'InterNetwork' -or $port -lt 1 -or $port -gt 65535 -or $port -eq 8877 -or
        $center.Scheme -ne 'https' -or $center.HostNameType -ne 'IPv4' -or $center.PathAndQuery -ne '/' -or $center.UserInfo -or $center.Fragment) {
        throw 'Invalid enrollment settings'
    }
    if (!$CenterSourceIP) { $CenterSourceIP = [ipaddress]::Parse($center.Host) }
    $envFile = Join-Path $Root 'bridge.env'
    $envData = "VEST_CENTER_URL=$($cfg.center)`nVEST_NODE_ID=$($cfg.node)`nVEST_NODE_TOKEN=$($cfg.node_token)`nVEST_PLUGIN_TOKEN=$($cfg.plugin_token)`n"
    $authority = Join-Path $stage 'center-root.crt'
    $savedCA = Join-Path $Root 'center-root.crt'
    if ((Test-Path -LiteralPath $envFile) -and [IO.File]::ReadAllText($envFile) -cne $envData) { throw 'This folder belongs to another enrollment' }
    if ((Test-Path -LiteralPath $savedCA) -and (Get-FileHash $authority).Hash -ne (Get-FileHash $savedCA).Hash) { throw 'Center CA has changed' }
    $taskName = 'VestFleet.Node.'+$cfg.node
    $stateDir = Join-Path $Root 'node-state'
    $prior = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($prior -and (!$prior.Actions[0].Arguments.Contains('"'+$stateDir+'\supervisor\node_agent.py"') -or !(Test-Path -LiteralPath $envFile))) {
        throw "Another installation owns $taskName"
    }
    if (!$prior -and (Get-NetTCPConnection -LocalPort 8877 -State Listen -ErrorAction SilentlyContinue)) { throw 'Port 8877 already has a bridge' }
    [IO.File]::WriteAllText($envFile,$envData)
    Copy-Item -LiteralPath $authority -Destination $savedCA -Force
    & certutil.exe -user -f -addstore Root $savedCA | Out-Null
    if ($LASTEXITCODE) { throw 'Could not trust enrollment CA for this user' }
    if ((Invoke-RestMethod -Uri ($cfg.center+'/healthz') -TimeoutSec 12).service -ne 'center') { throw 'Center HTTPS check failed' }

    $bin = Join-Path $Root 'tools'
    $null = [IO.Directory]::CreateDirectory($bin)
    $pythonDir = Join-Path $bin 'python'
    $python = Join-Path $pythonDir 'tools\python.exe'
    if (!(Test-Path -LiteralPath $python)) {
        $feed = 'https://api.nuget.org/v3-flatcontainer/python'
        $ver = (Invoke-RestMethod "$feed/index.json").versions | Where-Object { $_ -match '^3\.13\.\d+$' } |
            Sort-Object { [version]$_ } -Descending | Select-Object -First 1
        if (!$ver) { throw 'Python x64 runtime unavailable' }
        Install-Zip "$feed/$ver/python.$ver.nupkg" $pythonDir 'tools\python.exe' $null
    }
    & $python -c 'import ssl, sqlite3, sys; assert sys.version_info >= (3,12)'
    if ($LASTEXITCODE) { throw 'Python runtime failed its startup check' }
    $caddyDir = Join-Path $bin 'caddy'
    $caddy = Join-Path $caddyDir 'caddy.exe'
    if (!(Test-Path -LiteralPath $caddy)) {
        $release = Invoke-RestMethod 'https://api.github.com/repos/caddyserver/caddy/releases/latest'
        $asset = $release.assets | Where-Object { $_.name -match '^caddy_[\d.]+_windows_amd64\.zip$' } | Select-Object -First 1
        if (!$asset -or $asset.digest -notmatch '^sha256:([0-9a-f]{64})$') { throw 'Missing official Caddy release or SHA-256 digest' }
        Install-Zip $asset.browser_download_url $caddyDir 'caddy.exe' ($asset.digest.Substring(7))
    }
    $chromeDir = Join-Path $bin 'chrome'
    $chrome = Join-Path $chromeDir 'chrome-win64\chrome.exe'
    if (!(Test-Path -LiteralPath $chrome)) {
        $versions = Invoke-RestMethod 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
        $download = $versions.channels.Stable.downloads.chrome | Where-Object platform -eq 'win64' | Select-Object -First 1
        if (([uri]$download.url).Host -ne 'storage.googleapis.com') { throw 'Unexpected Chrome for Testing source' }
        Install-Zip $download.url $chromeDir 'chrome-win64\chrome.exe' $null
    }

    $proxyName = 'VestFleet.Https.'+$cfg.node
    $proxyFile = Join-Path $Root 'Caddyfile'
    $previousProxy = Get-ScheduledTask -TaskName $proxyName -ErrorAction SilentlyContinue
    $proxyArgs = 'run --config "' + $proxyFile + '" --adapter caddyfile'
    if ($previousProxy -and ($previousProxy.Actions[0].Execute -ne $caddy -or $previousProxy.Actions[0].Arguments -ne $proxyArgs)) { throw "Another installation owns $proxyName" }
    if (!$previousProxy -and (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { throw "Port $port already in use" }
    $certChanged = $false
    foreach ($file in @('server.key','server.crt')) {
        $target = Join-Path $Root $file
        $incoming = Join-Path $stage $file
        if (!(Test-Path -LiteralPath $target) -or (Get-FileHash $target).Hash -ne (Get-FileHash $incoming).Hash) {
            Copy-Item -LiteralPath $incoming -Destination $target -Force
            $certChanged = $true
        }
    }
    $tlsDir = $Root.Replace('\','/')
    $proxyConfig = @"
{
    admin off
    auto_https disable_redirects
    default_sni $ip
}
https://${ip}:$port {
    tls "$tlsDir/server.crt" "$tlsDir/server.key"
    @center path /v1/status /v1/logs /v1/ledger /v1/commands/*
    handle @center {
        reverse_proxy 127.0.0.1:8877
    }
    handle {
        respond 404
    }
}
"@
    [IO.File]::WriteAllText($proxyFile,$proxyConfig)
    & $caddy validate --config $proxyFile --adapter caddyfile
    if ($LASTEXITCODE) { throw 'Caddy configuration validation failed' }
    if ($previousProxy -and $certChanged) {
        Stop-ScheduledTask -TaskName $proxyName
        for ($attempt=0; $attempt -lt 20 -and (Get-ScheduledTask -TaskName $proxyName).State -eq 'Running'; $attempt++) { Start-Sleep -Milliseconds 250 }
    }
    Start-LoginTask $proxyName $caddy $proxyArgs
    $ruleName = 'VestFleet.Https.'+$cfg.node
    if (!(Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
        $null = New-NetFirewallRule -Name $ruleName -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -RemoteAddress $CenterSourceIP.IPAddressToString -Program $caddy
    } else {
        Get-NetFirewallRule -Name $ruleName | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress $CenterSourceIP.IPAddressToString | Out-Null
    }
    $db = Join-Path $Root 'data\bridge.sqlite3'
    if (!$prior) {
        & (Join-Path $stage 'Install-VestNode.ps1') -Revision $cfg.revision -StateDir $stateDir -Database $db -EnvFile $envFile -Python $python -Ssh:$Ssh
    } elseif ($prior.State -ne 'Running') { Start-ScheduledTask -TaskName $taskName }
    $ready = $false
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        try { $ready = (Invoke-RestMethod 'http://127.0.0.1:8877/v1/status' -Headers @{Authorization='Bearer '+$cfg.node_token} -TimeoutSec 2).node_id -ceq $cfg.node } catch {}
        if ($ready) { break }
        Start-Sleep -Seconds 1
    }
    if (!$ready) { throw "Bridge failed to report the enrolled node ID. See $stateDir\agent.log" }
    # Reach the public listener locally even when the cloud NAT does not support hairpinning.
    # Verify the enrolled IP identity and the actual authenticated proxy route.
    @'
import http.client, json, socket, ssl, sys
from pathlib import Path
root, ip, port = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
env = dict(line.split("=", 1) for line in (root/"bridge.env").read_text().splitlines())
ctx = ssl.create_default_context(cafile=str(root/"center-root.crt"))
for path in ("/v1/status", "/healthz"):
    with socket.create_connection(("127.0.0.1", port), timeout=10) as conn:
        with ctx.wrap_socket(conn, server_hostname=ip) as tls:
            req = f"GET {path} HTTP/1.1\r\nHost: {ip}:{port}\r\nAuthorization: Bearer {env['VEST_NODE_TOKEN']}\r\nConnection: close\r\n\r\n"
            tls.sendall(req.encode("ascii"))
            response = http.client.HTTPResponse(tls)
            response.begin()
            if path == "/v1/status":
                if response.status != 200 or json.load(response).get("node_id") != env["VEST_NODE_ID"]:
                    raise SystemExit("HTTPS bridge did not return the enrolled node")
            elif response.status != 404:
                raise SystemExit("Unexpected public bridge route")
'@ | & $python - $Root $cfg.ip $port
    if ($LASTEXITCODE) { throw 'Public HTTPS listener failed its TLS or route check' }
    $extension = Join-Path $stateDir 'extension'
    $installedManifest = Get-Content -Raw -Encoding UTF8 (Join-Path $extension 'manifest.json') | ConvertFrom-Json
    $installedRevision = (Get-Content -Raw -Encoding UTF8 (Join-Path $stateDir 'active.json') | ConvertFrom-Json).revision
    if (!$prior -and ($installedRevision -cne $cfg.revision -or ($cfg.version -and $installedManifest.version -cne $cfg.version))) {
        throw 'Installed application does not match the enrollment version and revision'
    }
    Write-Host "Installed bridge revision: $installedRevision | Extension on disk: $($installedManifest.version)"
    $marker = Join-Path $Root 'browser-provisioned'
    if (!(Test-Path -LiteralPath $marker)) {
        $background = Join-Path $extension 'background.js'
        $seed = @{label=$cfg.node; token=$cfg.plugin_token} | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $extension 'fleet-pair.json'),$seed)
        $pairFile = Join-Path $stage 'pair.js'
        if (![IO.File]::ReadAllText($background).Contains('function firstAccountPage(')) {
            [IO.File]::AppendAllText($background,"`n"+[IO.File]::ReadAllText($pairFile))
        }
        [IO.File]::WriteAllText($marker,'Ready')
    }
    $profile = Join-Path $Root 'browser-profile'
    $browserArgs = '--user-data-dir="'+$profile+'" --load-extension="'+$extension+'" --no-first-run --no-default-browser-check https://next.vestmarkets.com/accounts'
    Start-LoginTask ('VestFleet.Browser.'+$cfg.node) $chrome $browserArgs
    Write-Host "Installed $($cfg.node). Sign in to Vest in the dedicated browser. First accounts page binds read-only."
    Write-Host "Center: $($cfg.center) | Bridge: https://${ip}:$port | Node log: $stateDir\agent.log"
} finally {
    $lock.Dispose()
    $resolved = [IO.Path]::GetFullPath($stage)
    if ([IO.Path]::GetDirectoryName($resolved) -eq $Root -and [IO.Path]::GetFileName($resolved) -match '^setup-[0-9a-f-]{36}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
