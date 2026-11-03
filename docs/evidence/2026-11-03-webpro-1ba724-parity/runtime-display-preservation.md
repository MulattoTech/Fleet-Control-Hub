# Existing runtime display correction preserved

During the webpro-20261103T050255Z-1ba724 Hub rollout dry run, source verification
refused to equate the directory label `0dc530f99bc2eb6f5696f567f0015d07e4a850f8`
with the actual running source. No live file or process was changed.

The old release's package.json and package-lock.json match current protected-test
main `5535c11daaf4683a76442e971fd81c03daee30e6` exactly (Git blobs
35b405c76ea3354a67f7da8ee09b20de6b253408 and
5be4ec05d73bcfe7c444daa165557dae6086dcb7).
Its adapters.js blob is 00c08834950ce871c4bc61fc6a1c5e51fa3565d9.
Against current main, the only adapter difference reads the native emergency
scope instead of hard-coding machine-wide scope. The remaining old release
source files match its labeled commit.

This PR preserves that existing runtime display behavior in canonical source.
Recognized fleet-owned and machine values remain distinct; missing/unknown
evidence displays unknown. Dispatch, cutoff thresholds, quota settings,
start/control methods and controller packages are unchanged.

Open PR3 at1689f1ee and PR5 at50881d81 were checked: neither changes
src/adapters.js or the new regression file. The MJ-TH-FLEET scope was extended
in issue905/PR10 to preserve this existing correction during the authorized rollout.
Seven synthetic telemetry cases verify scope display, no POSTs, unchanged
dispatch/quota observations and no raw unrecognized scope disclosure.

The prior release directory and launcher remain the rollback authority by their
measured bytes; its directory name alone is not a verified whole-runtime SHA.
The rollout must verify an exact new-main source manifest, retain the old
directory and private launcher backup, and restart only the identified Hub.
This document does not claim deployment or emergency-control execution.

## Native verification history

The first full Windows run had 71 PASS /2 FAIL /0 SKIP. One old status fixture
expected machine scope without providing native scope; it now supplies explicit
machine evidence. The other failure is an existing test binding port4326, which
the shared Windows host refuses with EACCES. The second full run has72 PASS
/1 FAIL /0 SKIP, solely that port permission error. No other process was stopped
and no host reservation was changed. All seven new scope cases pass. The required
clean hosted Windows/Node24 workflow must pass before merge; these native failures
remain recorded and are not relabeled as passes or skips.
