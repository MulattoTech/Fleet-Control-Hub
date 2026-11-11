# Fleet Control: single owned process on 4320

The production Hub embeds the packaged MJobs controller directly into the same Node.js process. The controller exports handleRequest and does not open a listener when imported. The Hub's /fleet/ boundary validates routes, Cloudflare Access, origin, and action headers, then calls the handler in memory. The Hub's MJobs adapter calls http://127.0.0.1:4320/fleet/api/* and no longer uses ports 8787 or 18729.

BabyTracker on 4319 and Mission-only analytics on 18726 may still run; neither is a dependency for the native MJobs controller.

## Persistent state

Do not run a packaged controller directory with empty state in production. The live state lives under C:\Tools\AO-Fleet-Control, including quota policy, emergency audit and restore snapshots. The production Hub launcher must set environment variable FLEET_MJOBS_RUNTIME_DIR to C:\Tools\AO-Fleet-Control.

The source-only installer copies 220 verified package files and preserves runtime JSON/JSONL and other evidence. Never copy runtime state into Git, discard a latch, rearm quota, or start fleet work during this migration.

## Cutover checklist

1. Verify current Hub and native service identity and PIDs. Confirm automatic MJobs dispatch is paused, pending writes have settled, and the existing native process is quiescent. Preserve its scheduled-task configuration for rollback.
2. Record the tested source revision. Pass npm test, npm run test:mjobs, npm run test:babytracker, npm run test:lifecycle, npm run verify:ui, and npm run verify:packages. Test the new Hub on a temporary port using a separate staging runtime directory. Stage offline status needs a copy of the verified restore snapshot; never share the live state directory concurrently.
3. Back up every installed source file and the persistent controller state/audit/policies with ACLs. Stop only the verified old 8787 process. Confirm its listener is gone.
4. From the reviewed release, run: node scripts/controller-package.js install mjobs-controller C:\Tools\AO-Fleet-Control --apply. Set FLEET_MJOBS_RUNTIME_DIR in the Hub launcher and point it at the reviewed release. Restart only the Hub task. Do not launch the old native scheduled task.
5. Confirm Hub /api/health reports nativeFleetOrigin of embedded:in-process; /fleet/api/health reports port 4320; /fleet/api/state and /api/status show preserved state and connected MJobs; /fleet/ and /fleet/app.js render. Inspect emergency, quota, pause and current run without making changes. Unauthenticated actions must fail with 403.
6. Confirm no listener remains on 8787 or 18729. Disable the old MJobs Fleet - Dashboards Standard scheduled task and update old shortcuts. The workspace launcher now starts only Hub and BabyTracker.
7. Verify the Cloudflare Tunnel still targets 127.0.0.1:4320 and Access rejects an unauthorized identity. Update the installed remote exporter from the verified MJobs package so it reads the 4320 /fleet/api/ endpoints.
8. Reboot validation is required before declaring durable startup readiness. Recheck URLs, process ownership, logs, quota and emergency latches; do not send Start or rearm.

## Fail closed and rollback

If the embedded controller cannot load or native state is incomplete, do not silently fall back to 8787 or 18729. Keep dispatch paused. Stop the verified new Hub PID, restore the backed-up native source and launcher, start the old controller task if explicitly needed, and confirm its health before reopening controls. Preserve state written by the unsuccessful attempt for analysis. Do not overwrite recent runtime logs/state with stale backups.

A source merge is not a deployment. Production is complete only after the running 4320 process uses the reviewed release, native calls succeed, old listeners are absent, and remote/startup validation passes.
