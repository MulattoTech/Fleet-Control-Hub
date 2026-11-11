# Fleet Control port 18729 retirement · historical guarded cutover

**Superseded by [4320 standalone cutover](4320_STANDALONE.md).** The ownership and fallback details below describe the earlier intermediate migration through 8787. Current source embeds native MJobs directly in Hub 4320. Do not follow the old standalone 8787 startup instructions.

## New ownership

| Function | Owner | Normal entry |
|---|---|---|
| Unified local and owner-protected overview | Fleet Hub Node | 127.0.0.1:4320 |
| MJobs native controls and assets | MJobs controller Node | 127.0.0.1:8787, relayed at 4320/fleet/ |
| BabyTracker native controls | BabyTracker controller | 127.0.0.1:4319, relayed at 4320/babytracker/ |
| MJ-REQ/MJ-REF acceptance counts and group breakdown | Local canonical matrices | Hub 4320/api/mission-status |
| Mission-only runtime/launch and campaign evidence | Verified Python Mission service | 127.0.0.1:18726 |
| External read-only mission snapshot | Mission exporter | Sources: 8787 and 18726 |

Port 18729 is retired only when **all** verifications below succeed.
No controller, Hub native view, acceptance reader, workspace launcher,
Codex profile guard, or remote status exporter should then target 18729.
The native controller at 8787 still owns fleet mutations; this is intentional
and is not equivalent to an independent orchestration engine.

## Required sequencing

1. Preserve the existing Hub release, launch scripts, old Mission redirect,
   scheduled-task XML, verification manifest, and logs. Do not copy local
   state, tokens, databases, or logs into Git.
2. Merge a reviewed branch only after complete Hub tests, UI generation check,
   controller package hashes, Windows launcher tests, Python Mission tests,
   and required hosted CI pass on the exact candidate.
3. Install Hub from exact merged source. Keep 18729 running temporarily.
   Start the candidate on a temporary loopback port and verify overview,
   /api/health, /api/mission-status, /fleet/, /fleet/app.js,
   /fleet/api/health, and invalid/unauthorized controls.
   Check native assets use /fleet/ and requests target 8787, not 18729.
4. Update the native dashboard source-only package and startup script
   without overwriting user runtime state. The native task must no longer
   launch Python on 18729 or point its shortcut at that port.
5. Change 18726 from its old redirect to the verified Python Mission service.
   Stop only the old 18726 redirect process/task. Start the new hidden
   supervised launcher on 18726 using the same user safety boundary.
   Verify /api/launcher/health, /api/state, /api/progress and
   /api/progress/campaigns schemas and freshness. Do not change worker
   or fleet dispatch state.
6. Update the read-only exporter source to 18726, verify all eight
   read sources, and observe a fresh sanitized snapshot. Check the
   owner-protected remote Mission view and its campaign details.
7. Verify Cloudflare Access still requires the owner identity, rejects
   unauthenticated controls, and routes fleet.m-techlabs.com to 4320.
   Never expose 8787, 18726 or controller action ports publicly.
8. Disable only the obsolete 18729 autostart path. Gracefully stop
   the verified 18729 Python process after proving no dependency remains.
   Confirm no listener on 18729 and that 4320, 8787, 18726, 4319 and
   remote URLs continue to work. Verify reboot behavior when convenient.
9. Record exact source SHA, package digest, task changes, health checks,
   exporter freshness, and any unavailable verification honestly.

## Safety and rollback

- Never kill fleet workers, launch Codex sessions, rearm emergency protection,
  merge unreviewed PRs or infer requirement PASS from CI activity.
- If 18726 fails readiness, restore its saved task and redirect; leave
  18729 online until the failure is diagnosed.
- If Hub authentication or source differs from the tested release, restore
  the previous Hub release before retiring any dependency.
- If the remote exporter loses fresh Mission or campaign data, restore
  its prior source and Mission service. Mark external status unavailable
  until a verified snapshot returns; never republish stale success.
- Backup and rollback paths are outside Git and require owner review.
