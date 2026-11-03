# Bounded closed-PR response repair

The live GitHub response for the existing100-PR window exceeded the Hub's2MB subprocess output cap, keeping the catalog visibly stale. The exact unchanged transport invocation reproduced ERR_CHILD_PROCESS_STDIO_MAXBUFFER. The fix uses GitHub CLI JSON field selection for this one route before stdout buffering, retaining every row and all fields used for reference/merge matching. Full PR bodies are retained in the server-side matching input; unused repository/user objects are omitted and no bodies reach the browser.

The real corrected response passed with100 rows and440,284 output bytes under the unchanged2,000,000-byte/10-second limits. All required fields and the exact audit merge linkage survived. The100-record history window remains explicitly incomplete; deployment and parity acceptance are not inferred.

The versioned verification record retains the baseline failure, six new deterministic transport/privacy/bounds regressions,26 focused parity tests,85 Hub tests,121 BabyTracker tests,21 Python tests and package/UI integrity. The source native preflight had57 passes and one failure in an unchanged module; one diagnostic execution passed all22 cases. Its original failure and UNKNOWN cause are retained. The local Node27-alpha/npm warning is distinct from the required hosted Node24 candidate gate. No native code, global runtime, fleet quota or Access policy was changed.

Source tests and probes do not substitute for independent review, a fresh actual candidate, hosted gates, serialized merge or guarded Hub deployment. Those outcomes are recorded on the delivery PR and MJobs issue905.
