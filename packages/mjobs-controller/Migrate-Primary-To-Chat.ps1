$ErrorActionPreference='Stop'
$AO=Join-Path $env:LOCALAPPDATA 'Programs\agent-orchestrator\resources\daemon\ao.exe'
$Base='http://127.0.0.1:3001'
$Project='mjobs-luna'
$Old='mjobs-luna-34'
$backup=Join-Path 'C:\Tools\AO-Fleet-Control\backups' ('primary-chat-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force|Out-Null
$data=Invoke-RestMethod "$Base/api/v1/sessions"
$active=@($data.sessions|Where-Object {$_.projectId -eq $Project -and -not $_.isTerminated})
$roots=@($active|Where-Object {$_.kind -eq 'orchestrator'})
if($roots.Count -ne 1 -or $roots[0].id -ne $Old){throw 'Unexpected root; no changes made'}
$root=$roots[0]
if($root.activity.state -ne 'idle' -or $root.branchState.commits -ne 0 -or $root.branchState.unpushed -ne 0 -or @($root.prs).Count -ne 0){throw 'Root is not idle or has work. Safe cutover refused'}
if($active.Count -ne 29){throw "Expected 29 existing agents; found $($active.Count)"}
$data|ConvertTo-Json -Depth 60|Set-Content (Join-Path $backup 'sessions-before.json') -Encoding UTF8
& $AO session history $Old --limit 50 | Set-Content (Join-Path $backup 'old-root-history.txt') -Encoding UTF8
Write-Output "Preflight passed; backup=$backup"
$exit=& $AO session exit-agent $Old --project $Project --json | ConvertFrom-Json
if(-not $exit.ok){throw 'Cannot safely exit old root'}
$killed=& $AO session kill $Old --project $Project 2>&1 | Out-String
if($LASTEXITCODE -ne 0){throw "Old root archiving failed: $killed"}
Write-Output 'Old nonresponsive TUI root archived with history preserved'
$prompt=@'
You are the primary GPT-5.6 Sol Medium Chat orchestrator for the existing MJobs mixed fleet, replacing mjobs-luna-34. Take direct, continuous operational ownership of the 28 existing worker/coordinator/reviewer sessions. The user explicitly authorizes autonomous bounded P0/P1 work allocation, PR integration after required checks, and an ongoing fleet throughput campaign.
Your job is to MAINTAIN a live exclusive issue and file-ownership ledger, assign actual GitHub P0/P1 issues instead of merely asking idle agents for reports, and keep work flowing when agents finish. Existing secondary Sol coordinators: mjobs-luna-17 P0, mjobs-luna-18 P1, mjobs-luna-19 quality. Implementation workers include Luna, Sol, Astra; reviewer lanes exist. Do not spawn additional agents; keep the 29 total. Immediately reconcile the 12 current open PRs and update exact-head CI/reviews; prioritize failing PRs 772, 773, 775, 779, and eligible passing PRs 761/765 as appropriate. Existing linked session ownership and worktrees must be preserved.
Safety: C:/Tools/Dev/MJobs main has SIX modified files; do NOT touch, reset, clean or merge local dirty main. Only work in isolated AO worktrees. No force-push, no deletion, no credential access, no actual employer submission, no bypassing GitHub required CI/protection. Merge only after required review and exact-head CI pass. Reject duplicate issue/file claims, avoid heavy local tests in >3 lanes simultaneously.
Use ao send --session ID --message TEXT without --steer for TUI workers, verify activity and responses, and send explicit file ownership + acceptance instructions. Do not wait passively for workers to request assignments. When you receive another Fleet Control refill checkpoint, reconcile changed status and promptly dispatch the next wave. Favor completed and accepted original P0/P1 requirements rather than numbers of PRs or token consumption. Create a compact ledger in your own worktree and pass completion/blockers through AO reports.
Start by reading ao session history mjobs-luna-34 --limit 8 and checking active MJobs session list and GitHub PRs. Then assign distinct work to existing agents.
'@
$arguments=@('spawn','--project',$Project,'--kind','orchestrator','--mode','chat','--harness','codex','--model','gpt-5.6-sol','--effort','medium','--name','F29-ORCH-01 Sol Chat Primary (Sustained)','--prompt',$prompt)
$out=& $AO @arguments 2>&1 | Out-String
if($LASTEXITCODE -ne 0){
  Write-Warning "New root spawn failed: $out"
  & $AO session restore $Old --project $Project | Out-Null
  throw "New root failed. Attempted to restore legacy: $out"
}
Start-Sleep -Seconds 3
$after=(Invoke-RestMethod "$Base/api/v1/sessions").sessions
$live=@($after|Where-Object {$_.projectId -eq $Project -and -not $_.isTerminated})
$new=@($live|Where-Object {$_.kind -eq 'orchestrator'})
if($new.Count -ne 1 -or $new[0].model -ne 'gpt-5.6-sol' -or $new[0].mode -ne 'chat'){
 Write-Warning "Root not verified. $out"
 throw 'New Chat root was not confirmed. Inspect sessions before making changes.'
}
if($live.Count -ne 29){Write-Warning "Fleet count changed to $($live.Count)"}
$record=[pscustomobject]@{oldId=$Old;newId=$new[0].id;newMode=$new[0].mode;createdAt=(Get-Date).ToString('o');backup=$backup}
$record|ConvertTo-Json|Set-Content 'C:\Tools\AO-Fleet-Control\primary-session.json' -Encoding UTF8
Write-Output ("SUCCESS PRIMARY_CHAT="+$new[0].id+" TOTAL="+$live.Count+" backup="+$backup)
