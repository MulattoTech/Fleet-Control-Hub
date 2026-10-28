# Remote control deployment

The owner approved a dedicated remote route on 28 October 2026. The deployment on MulattoTechBox uses `https://fleet.m-techlabs.com` and keeps the hub and native controllers bound to loopback. No tunnel credential, Access token, local logs or fleet runtime data is stored in this repository.

## Deployed route

- A dedicated Cloudflare Access self-hosted application has an owner-only allow policy through the existing Cloudflare identity provider. Its application audience is stored only in local deployment configuration.
- A dedicated Tunnel forwards the fleet hostname to `http://127.0.0.1:4320`; the catch-all returns 404. Tunnel ingress requires a valid Access JWT for that application audience.
- Proxied CNAME: `fleet.m-techlabs.com` points to the dedicated tunnel. The connector runs on MulattoTechBox with a restricted token file under the owner's local application-data directory. The token is never placed in a command line or in Git.
- Hub remote mode sets `FLEET_HUB_REMOTE_HOST`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `CF_ACCESS_OWNER_EMAIL` in a local launcher. The hub separately verifies the signed Access JWT issuer, audience, token type and owner email on **every** request to the remote hostname.
- Windows logon tasks `Fleet Control Hub` and `Fleet Control Tunnel` launch the hub and connector under the owner's account. Their local launch scripts and token file are restricted to that account and SYSTEM. These tasks need an owner logon; they are not system boot services.

## Verification on 28 October 2026

- Both logon tasks were started and reported running after their prior ad hoc processes were stopped. One tunnel connector process was present; its command line contained only the token-file path.
- `http://127.0.0.1:4320/api/status` returned 200 from the task-launched hub.
- A direct loopback request with `Host: fleet.m-techlabs.com` and no Access JWT returned 403.
- An unauthenticated request to `https://fleet.m-techlabs.com/api/status` returned 302 to Cloudflare Access sign-in.
- The owner signed in through Cloudflare Access and the remote dashboard loaded both fleets' live status. The Access app uses a `SameSite=Lax` authorization cookie to complete the identity-provider redirect, while retaining its owner-only policy and HttpOnly cookie.
- Missing and invalid Access JWTs were rejected at the origin with 403. An unauthenticated action request was also rejected with 403. The source tests cover signed owner assertions, same-origin action tokens and rejection of cross-site POST requests.
- A later owner-authorized browser test exercised Pause and Graceful stop for both fleets and one bounded BabyTracker Start attempt. The Start did not verify a new session; native control stayed paused and required explicit reconciliation. These outcomes do not establish active-work behavior or full controller parity.

The route's authentication has two layers: Cloudflare Access at the edge and the hub's own signature/claim check at the origin. Action endpoints additionally require a same-origin request and a session action token. Start flows use a fresh preview and exact confirmation, and native controllers enforce their own scope. Review assessment remains local-only because the remote view does not provide underlying review evidence.

## Operations

If MulattoTechBox is logged out or restarted, log in as the owner to launch both tasks. Check that the two tasks are running and open `https://fleet.m-techlabs.com` in an owner-signed-in browser. Keep the local tunnel token file private; rotate it through Cloudflare and replace the local file if exposed. Do not copy it into Git or an issue.

The existing M-TechLabs Docker tunnel was left unchanged; that container cannot reach the hub's loopback listener. No native controller port is published through Cloudflare. The public repository is source code, while the protected remote control interface is hosted through Cloudflare Access.

Cloudflare references: [Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), [validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), and [Tunnel origin Access validation](https://developers.cloudflare.com/tunnel/reference/origin-parameters/#access-settings).
