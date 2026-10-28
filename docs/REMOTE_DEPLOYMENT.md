# Remote control deployment plan

The local hub is ready to accept an authenticated remote hostname, but remote mode is disabled until the access change is approved and configured. Do not route the existing M-TechLabs Docker tunnel to the local hub: that container cannot reach the hub's loopback listener. Do not rebind the hub or controllers to a LAN address to make it reachable.

## Proposed route

1. Create a dedicated **owner only** Cloudflare Access self-hosted application for `fleet.m-techlabs.com`, with the same owner identity as the existing M-TechLabs hub. Record its application audience tag.
2. Create a dedicated Cloudflare Tunnel route for that hostname, with a `cloudflared` connector on MulattoTechBox forwarding to `http://127.0.0.1:4320`. Set tunnel ingress Access JWT verification to required and restrict it to the new application's audience. Keep a 404 catch-all.
3. Set `FLEET_HUB_REMOTE_HOST=fleet.m-techlabs.com`, `CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com`, `CF_ACCESS_AUD=<application audience>`, and `CF_ACCESS_OWNER_EMAIL=<owner email>` in the machine's protected local service configuration. These values are never committed. The hub also verifies the signed Access JWT on every remote request, including assets and status.
4. Confirm an unauthenticated request is denied before testing a signed-in browser. Verify status, then test scoped pause/stop against a disposable fixture before any live action. Add a link in the existing M-TechLabs portal only after these checks.

The hub includes guarded Start flows. It reads current quota and roster information, shows the spending consequences, and requires an exact confirmation phrase. BabyTracker uses its bounded native Start and remains blocked while draining. MJobs uses a native MJobs-only subset, bound to the unchanged global snapshot and an exact revision. Its scoped restore passed source tests; no live Start action was submitted during development. Remote deployment remains disabled pending approval.

The M-TechLabs portal currently serves read-only mission status and explicitly avoids command proxies. A remote fleet route would materially expand control access. Creating the Access app, tunnel route, connector credential or portal link requires action-time confirmation. No such change is made by this repository.

Cloudflare references: [Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), [validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), and [Tunnel origin Access validation](https://developers.cloudflare.com/tunnel/reference/origin-parameters/#access-settings).
