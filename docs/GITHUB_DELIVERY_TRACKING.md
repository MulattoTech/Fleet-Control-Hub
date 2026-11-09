# MJobs GitHub delivery tracking

Fleet Overview at the local Hub and the protected `fleet.m-techlabs.com` route
shows GitHub development activity separately from Mission Control acceptance and
native AO/Codex sessions.

- `GET /api/delivery` is read-only. It queries the public MJobs GitHub PR API
  for open PRs (including drafts) and merged PRs since the UTC date seven days
  before the observation. It returns counts only, not PR bodies, comments,
  local paths or tokens.
- Results are cached for five minutes on the Hub. An unavailable, rate-limited,
  malformed or incomplete GitHub response is explicitly **unavailable**, never
  zero. Failed attempts retry after up to one minute. The UI discards stale
  displayed counts when current readings are unavailable.
- A PR is delivered source code, not a completed MJobs requirement. The
  separately sourced canonical 366 MJ-REQ and 59 MJ-REF acceptance matrices
  retain the sole PASS authority. A local Codex session count cannot measure
  ChatGPT Web Pro sessions; the Github delivery card represents their published
  PR outcomes instead.
- MJobs native controller may be connected but its AO agent runtime offline.
  That condition does not hide the separate read-only GitHub delivery card.

Check the live JSON at `http://127.0.0.1:4320/api/delivery` or through
the authenticated Fleet site. Regression command:
`node --test test/github-delivery.test.js`.
