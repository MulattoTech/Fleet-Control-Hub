$ErrorActionPreference='Stop'
$exe=Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
$dir='C:\Tools\AO-Fleet-Control\backups\watchdog-recovery-20261024-014000'
$arguments=@('exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--sandbox','read-only','-m','gpt-5.6-sol','-c','model_reasoning_effort=low','-C',$dir,'Respond with the single word READY. Do not call tools.')
$start=[Diagnostics.ProcessStartInfo]::new($exe)
$start.UseShellExecute=$false
$start.RedirectStandardInput=$true
$start.RedirectStandardOutput=$true
$start.RedirectStandardError=$true
$start.CreateNoWindow=$true
$start.WorkingDirectory=$dir
foreach($arg in $arguments){[void]$start.ArgumentList.Add($arg)}
$process=[Diagnostics.Process]::Start($start)
$process.StandardInput.Close()
$stdOut=$process.StandardOutput.ReadToEndAsync()
$stdErr=$process.StandardError.ReadToEndAsync()
if(-not $process.WaitForExit(25000)){
 try{$process.Kill($true)}catch{}
 Write-Output 'PROBE=TIMEOUT_TERMINATED'
}else{
 Write-Output ('PROBE_EXIT='+$process.ExitCode)
}
foreach($line in @(($stdOut.GetAwaiter().GetResult() -split [char]10)|Select-Object -Last 12)){
 if($line){Write-Output ('STDOUT '+($line -replace 'C:\\Users\\[^\\ ]+','[HOME]'))}
}
foreach($line in @(($stdErr.GetAwaiter().GetResult() -split [char]10)|Select-Object -Last 18)){
 if($line){Write-Output ('STDERR '+($line -replace 'C:\\Users\\[^\\ ]+','[HOME]'))}
}
