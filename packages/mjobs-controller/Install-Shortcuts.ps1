$ErrorActionPreference='Stop'
$script='C:\Tools\AO-Fleet-Control\Start-Fleet-Control.ps1'
$powershell='C:\Program Files\PowerShell\7\pwsh.exe'
if(!(Test-Path $powershell)){$powershell='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'}
$desktop=[Environment]::GetFolderPath('Desktop')
$startup=[Environment]::GetFolderPath('Startup')
$shell=New-Object -ComObject WScript.Shell
$edge='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
foreach($spec in @(
 @{Path=(Join-Path $desktop 'MJobs Fleet Control.lnk'); Args='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Tools\AO-Fleet-Control\Start-Fleet-Control.ps1" -OpenBrowser'; Desc='Open MJobs Fleet Control dashboard'},
 @{Path=(Join-Path $startup 'MJobs Fleet Control Server.lnk'); Args='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Tools\AO-Fleet-Control\Start-Fleet-Control.ps1"';Desc='Start MJobs Fleet Control locally when signing in'}
)){
 $shortcut=$shell.CreateShortcut($spec.Path)
 $shortcut.TargetPath=$powershell
 $shortcut.Arguments=$spec.Args
 $shortcut.WorkingDirectory='C:\Tools\AO-Fleet-Control'
 $shortcut.Description=$spec.Desc
 if(Test-Path $edge){$shortcut.IconLocation="$edge,0"}
 $shortcut.Save()
 Write-Output "CREATED $($spec.Path)"
}
