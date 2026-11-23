"""Generate a provisioned, read-only Grafana dashboard from sanitized fleet telemetry."""

import json
from pathlib import Path

ROOT = Path(__file__).parent
DS = {"type": "yesoreyeram-infinity-datasource", "uid": "fleet-native"}
URL = "http://fleet-analytics-data:8080/analytics.json"
STATUS_URL = "http://fleet-analytics-data:8080/collector-status.json"
DESKTOP_ACTIVITY_URL = "http://fleet-analytics-data:8080/desktop-activity.json"
PANELS = []


def query(root, columns, fmt="table"):
    return {
        "refId": "A",
        "datasource": DS,
        "type": "json",
        "source": "url",
        "url": URL,
        "url_options": {"method": "GET", "data": ""},
        "parser": "backend",
        "format": fmt,
        "root_selector": root if root == "$" else "($age := $millis() - $toMillis(generatedAt); $age >= -10000 and $age <= 90000 ? (" + root + ") : [])",
        "columns": [
            {"selector": selector, "text": name, "type": kind}
            for selector, name, kind in columns
        ],
    }


def desktop_activity_query(root, columns):
    return {
        "refId": "A",
        "datasource": DS,
        "type": "json",
        "source": "url",
        "url": DESKTOP_ACTIVITY_URL,
        "url_options": {"method": "GET", "data": ""},
        "parser": "backend",
        "format": "table",
        "root_selector": root,
        "columns": [
            {"selector": selector, "text": name, "type": kind}
            for selector, name, kind in columns
        ],
    }


def panel(title, kind, x, y, w, h, target=None, unit="none", description=""):
    item = {
        "id": len(PANELS) + 1,
        "title": title,
        "description": description,
        "type": kind,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "datasource": DS,
        "targets": [target] if target else [],
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "color": {"mode": "palette-classic"},
                "thresholds": {
                    "mode": "absolute",
                    "steps": [{"color": "#8bbcff", "value": None}],
                },
            },
            "overrides": [],
        },
        "options": {},
    }
    if kind == "stat":
        item["fieldConfig"]["defaults"]["color"] = {"mode": "fixed", "fixedColor": "#8bbcff"}
        item["options"] = {
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "orientation": "auto",
            "textMode": "auto",
            "colorMode": "value",
            "graphMode": "none",
            "justifyMode": "auto",
            "wideLayout": True,
        }
    if kind == "timeseries":
        item["options"] = {
            "legend": {"displayMode": "list", "placement": "bottom"},
            "tooltip": {"mode": "multi", "sort": "desc"},
        }
        item["fieldConfig"]["defaults"]["custom"] = {
            "drawStyle": "line",
            "lineInterpolation": "smooth",
            "fillOpacity": 15,
            "lineWidth": 2,
            "showPoints": "never",
            "axisPlacement": "auto",
        }
    if kind == "table":
        item["options"] = {
            "showHeader": True,
            "cellHeight": "sm",
            "footer": {"show": False},
            "sortBy": [],
        }
    if kind == "barchart":
        item["options"] = {
            "orientation": "horizontal",
            "showValue": "auto",
            "groupWidth": 0.7,
            "barWidth": 0.8,
            "legend": {"displayMode": "hidden"},
            "tooltip": {"mode": "single"},
        }
    PANELS.append(item)
    return item


intro = panel(
    "FLEET TRACKER · Native telemetry, not simulated productivity", "text", 0, 0, 24, 3
)
intro["options"] = {
    "mode": "markdown",
    "content": "## Fleet Tracker\n[← Fleet Overview](https://fleet.m-techlabs.com/) · [Fleet Tracker](https://m-techlabs.com/mission-control/analytics/) · [Requirements and campaign progress](https://m-techlabs.com/mission-control/analytics/#requirements)\n\n**Executing** means a native active turn. Reserved agents are **on-call**, not busy. ETA values are conditional. Token use is not acceptance. Missing per-turn attribution remains unavailable.",
}
for i, (title, key, unit) in enumerate(
    [
        ("Executing · last observation", "executing", "short"),
        ("Queued", "queued", "short"),
        ("On-call reserve", "reserved", "short"),
        ("Completed turns · 24h", "completedTurns", "short"),
    ]
):
    panel(
        title,
        "stat",
        i * 6,
        3,
        6,
        4,
        query("[summary]", [(key, title, "number")]),
        unit,
    )
panel(
    "Output-token flow · 15-minute buckets",
    "timeseries",
    0,
    7,
    16,
    8,
    query(
        "tokenSeries",
        [("at", "Time", "timestamp"), ("output", "Output tokens", "number")],
        "timeseries",
    ),
    "short",
    "Native reported usage. The underlying feed is a rolling 24-hour window.",
)
panel(
    "Models by observed output tokens",
    "barchart",
    16,
    7,
    8,
    8,
    query(
        "models", [("model", "Model", "string"), ("output", "Output tokens", "number")]
    ),
    "short",
    "Observed usage models, not just the configured launch model.",
)
for i, (title, root, key, unit) in enumerate(
    [
        ("Input tokens · 24h", "summary", "inputTokens", "short"),
        ("Cache hits · 24h", "summary", "cachedInputTokens", "short"),
        ("Documentation drafts ready", "productivity", "artifactsReady", "short"),
        ("Quota remaining", "quota", "remainingPercent", "percent"),
    ]
):
    panel(
        title,
        "stat",
        i * 6,
        15,
        6,
        4,
        query("[" + root + "]", [(key, title, "number")]),
        unit,
    )
panel(
    "Dispatch flight board",
    "table",
    0,
    19,
    24,
    10,
    query(
        "agents",
        [
            ("name", "Agent", "string"),
            ("work.label", "Workflow state", "string"),
            ("work.assignedTask", "Assigned / planned task", "string"),
            ("work.queuePosition", "Queue position", "number"),
            ("work.estimatedStartAt", "Conditional start estimate", "timestamp"),
            ("work.nextEvaluationAt", "Next dispatcher check", "timestamp"),
            ("turnsCompleted", "Completed turns", "number"),
        ],
    ),
    description="An ETA is not a promise. CI waits, reserves, resource holds and paused dispatch remain distinct.",
)
for i, (title, key, unit) in enumerate(
    [
        ("Selected agent · completed turns", "turnsCompleted", "short"),
        ("Median turn wall time", "medianTurnSeconds", "s"),
        ("95th percentile turn", "p95TurnSeconds", "s"),
        ("Selected output tokens", "usage.output", "short"),
    ]
):
    panel(
        title,
        "stat",
        i * 6,
        29,
        6,
        4,
        query("agents[id='${agent}']", [(key, title, "number")]),
        unit,
    )
panel(
    "Selected agent · recorded workflow states",
    "state-timeline",
    0,
    33,
    24,
    7,
    query(
        "agents[id='${agent}'].transitions",
        [("at", "Time", "timestamp"), ("state", "Workflow", "string")],
    ),
    description="State observation begins when this collector was installed; no historical state is fabricated.",
)
panel(
    "Selected agent · latest 30 turns",
    "table",
    0,
    40,
    24,
    10,
    query(
        "agents[id='${agent}'].latestTurns",
        [
            ("startedAt", "Started", "timestamp"),
            ("endedAt", "Ended", "timestamp"),
            ("durationSeconds", "Wall seconds", "number"),
            ("state", "State", "string"),
            ("inputTokens", "Input tokens", "number"),
            ("cachedInputTokens", "Cached tokens", "number"),
            ("outputTokens", "Output tokens", "number"),
            ("usageAttribution", "Attribution basis", "string"),
        ],
    ),
    description="Per-turn usage requires a unique native-conversation and time-window match. Missing values are not zero; wall time includes tools and waiting.",
)
panel(
    "Freshness receipt",
    "table",
    0,
    50,
    24,
    5,
    query(
        "$",
        [
            ("generatedAt", "Feed generated", "timestamp"),
            ("source.observedAt", "Native source observed", "timestamp"),
            ("source.usageWindowComplete", "Usage import complete", "boolean"),
            ("dispatch.lastSuccess", "Last dispatch", "timestamp"),
        ],
    ),
    description="Do not infer current activity when the feed timestamp is over 90 seconds old. Fleet Atlas marks stale data explicitly.",
)

# Infinity reports an empty JSONata result as a query error. Keep a status-only
# row when the feed has no current counts, with absent numeric fields.
desktop_freshness = (
    "$now := $millis(); "
    "$valid := $type(schema_version) = 'number' and schema_version = 1; "
    "$export := $type(exported_at) = 'string' ? exported_at : null; "
    "$feedAge := $export ? $now - $toMillis($export) : 90001; "
    "$ageMs := function($row) { $type($row.observed_at) = 'string' ? $now - $toMillis($row.observed_at) : 90001 }; "
    "$fresh := function($row) { ($age := $ageMs($row); "
    "$row.status = 'fresh' and $feedAge >= -10000 and $feedAge <= 90000 "
    "and $type($row.max_age_seconds) = 'number' and $row.max_age_seconds >= 0 and $row.max_age_seconds <= 90 "
    "and $age >= -10000 and $age <= $row.max_age_seconds * 1000) }; "
    "$rows := $valid ? projects.($row := $; $merge([$row, { "
    "'status': $row.status = 'unavailable' ? 'unavailable' : $fresh($row) ? 'fresh' : 'stale', "
    "'exported_at': $export, 'age_seconds': $type($row.observed_at) = 'string' ? $floor($ageMs($row) / 1000) : null "
    "}])) : []; "
)
desktop_status = panel(
    "Codex Desktop activity · source status",
    "table",
    0,
    55,
    24,
    6,
    desktop_activity_query(
        "(" + desktop_freshness + "$count($rows) > 0 ? [$rows] : [{'status':'unavailable'}])",
        [
            ("project_id", "Project", "string"),
            ("source", "Source", "string"),
            ("status", "Source status", "string"),
            ("exported_at", "Feed exported", "timestamp"),
            ("observed_at", "Observed at", "timestamp"),
            ("latest_activity_utc", "Latest activity", "timestamp"),
            ("age_seconds", "Age (seconds)", "number"),
            ("max_age_seconds", "Freshness limit (seconds)", "number"),
            ("coverage_partial", "Coverage partial", "boolean"),
        ],
    ),
    description="Shows the project, collector and observation together. Freshness is evaluated when Grafana reads the export.",
)
desktop_counts = panel(
    "Codex Desktop activity · fresh project counts",
    "table",
    0,
    61,
    24,
    7,
    desktop_activity_query(
        "(" + desktop_freshness + "$live := $rows[status = 'fresh']; "
        "$count($live) > 0 ? [$live] : [{'status':'stale_or_unavailable'}])",
        [
            ("project_id", "Project", "string"),
            ("source", "Source", "string"),
            ("status", "Source status", "string"),
            ("exported_at", "Feed exported", "timestamp"),
            ("observed_at", "Observed at", "timestamp"),
            ("latest_activity_utc", "Latest activity", "timestamp"),
            ("age_seconds", "Age (seconds)", "number"),
            ("coverage_partial", "Coverage partial", "boolean"),
            ("counts.session_count", "Sessions", "number"),
            ("counts.active_process_count", "Active processes", "number"),
            ("counts.workspace_count", "Workspaces", "number"),
        ],
    ),
    description="Counts appear only for fresh observations. An expired or unavailable source leaves the count cells empty. Recorded zeroes remain visible.",
)
for item in PANELS:
    if item["gridPos"]["y"] >= 3:
        item["gridPos"]["y"] += 5
status_target = query(
    "$",
    [
        ("available", "Source status", "string"),
        ("reasonCode", "Reason code", "string"),
        ("message", "Reason", "string"),
        ("checkedAt", "Source checked", "timestamp"),
        ("lastSuccessAt", "Last successful observation", "timestamp"),
    ],
)
status_target["url"] = STATUS_URL
status_target["root_selector"] = (
    "($age := $millis() - $toMillis(checkedAt); "
    "$sampleAge := lastSuccessAt ? $millis() - $toMillis(lastSuccessAt) : 90001; "
    "$fresh := schemaVersion = 1 and staleAfterSeconds = 90 and $type(available) = 'boolean' "
    "and $age >= -10000 and $age <= 90000; "
    "$live := $fresh and available = true and reasonCode = 'OK' "
    "and $sampleAge >= -10000 and $sampleAge <= 90000; "
    # Keep the original fixed-field receipt. A compound object/message projection
    # failed on the installed Infinity backend; this bounded selector is verified
    # against that backend with live and synthetic receipts. Grafana maps the
    # admitted boolean to a label without reinterpreting historical evidence.
    "$fresh and (available = false or $live) ? [$] : [])"
)
source_health = panel(
    "Source health · last check",
    "table", 0, 3, 24, 5, status_target,
    description="No data means the source-health receipt is stale or invalid, not zero activity. This check is separate from the last successful observation. An offline source or identity mismatch never re-dates old counts. Data panels expire after 90 seconds.",
)
source_health["fieldConfig"]["overrides"] = [{
    "matcher": {"id": "byName", "options": "Source status"},
    "properties": [{"id": "mappings", "value": [{
        "type": "value", "options": {
            "true": {"text": "LIVE", "color": "#91d6b7"},
            "false": {"text": "SOURCE UNAVAILABLE", "color": "#edc67a"},
        },
    }]}],
}]
panel(
    "Codex Desktop activity · recent slices",
    "table",
    0,
    73,
    24,
    8,
    desktop_activity_query(
        "(" + desktop_freshness + "$live := $rows[status = 'fresh']; "
        "$slices := $live.($project := $; slices.{"
        "'project_id': $project.project_id, 'status': $project.status, "
        "'observed_at': $project.observed_at, 'age_seconds': $project.age_seconds, "
        "'label': label, 'role': role, 'latest_activity_utc': latest_activity_utc"
        "}); "
        "$count($slices) > 0 ? [$slices] : "
        "[{'status': $count($live) > 0 ? 'no_recent_slices' : 'stale_or_unavailable'}])",
        [
            ("project_id", "Project", "string"),
            ("status", "Source status", "string"),
            ("label", "Slice", "string"),
            ("role", "Role", "string"),
            ("latest_activity_utc", "Last slice activity", "timestamp"),
            ("observed_at", "Observed at", "timestamp"),
            ("age_seconds", "Age (seconds)", "number"),
        ],
    ),
    description="Recent slice activity from fresh project observations. Slice labels are temporary and carry no session identifiers.",
)
PANELS.sort(key=lambda item: (item["gridPos"]["y"], item["gridPos"]["x"]))
# Provision a portable placeholder. The existing observer refreshes the choices
# only after validating a live native source for this installation.
agents = ["mjobs-1"]
dashboard = {
    "uid": "fleet-atlas",
    "title": "Fleet Tracker · Operations Intelligence",
    "description": "Fleet Tracker using the Fleet Atlas Flight Deck visual style · read-only native observations sampled every 30 seconds. Missing token attribution remains unknown.",
    "tags": ["fleet", "native-telemetry", "read-only"],
    "schemaVersion": 40,
    "version": 1,
    "editable": False,
    "style": "dark",
    "timezone": "browser",
    "refresh": "30s",
    "links": [
        {"type": "link", "title": "Fleet Overview", "url": "https://fleet.m-techlabs.com/", "targetBlank": True, "includeVars": False, "keepTime": False},
        {"type": "link", "title": "Fleet Tracker", "url": "https://m-techlabs.com/mission-control/analytics/", "targetBlank": True, "includeVars": False, "keepTime": False},
    ],
    "time": {"from": "now-24h", "to": "now"},
    "graphTooltip": 1,
    "templating": {
        "list": [
            {
                "name": "agent",
                "label": "Inspect agent",
                "type": "custom",
                "query": ",".join(agents),
                "options": [
                    {"text": x, "value": x, "selected": x == agents[0]}
                    for x in agents
                ],
                "current": {"text": agents[0], "value": agents[0]},
                "includeAll": False,
                "multi": False,
                "hide": 0,
            }
        ]
    },
    "panels": PANELS,
}
(ROOT / "dashboards").mkdir(exist_ok=True)
(ROOT / "dashboards/fleet-atlas.json").write_text(
    json.dumps(dashboard, indent=2), encoding="utf-8", newline="\n"
)
print(
    json.dumps({"dashboard": "fleet-atlas", "panels": len(PANELS), "modelRequests": 0})
)
