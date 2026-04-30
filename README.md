# coolify-logs-proxy

Read-only proxy in front of the Coolify API. Lets Claude Code
(running in agent-vm on a PM's machine) fetch the build/deploy status
and runtime container logs for a given repo, without ever giving the
PM a Coolify token.

The Coolify token lives only in this service's environment. The
caller authenticates with their existing GitHub PAT (the one
`gh auth login` already issued during agent-vm provisioning) — the
proxy verifies that the token belongs to an active member of
`GITHUB_ORG` (default: `betagouv-experimentations`) before returning
anything sensitive.

## Endpoints

### `GET /logs/{repo}/{sha}`

Build/deploy status + last lines of the build logs for a given
commit. Use during/after a `/save` to know whether the build finished
and to surface errors.

```json
{
  "status": "in_progress" | "finished" | "failed" | ...,
  "commit": "abc123...",
  "commit_message": "feat: add partner search",
  "deployment_url": "https://...",
  "started_at": "...", "updated_at": "...", "finished_at": "...",
  "logs": "<last 200 lines of build output>"
}
```

### `GET /runtime-logs/{repo}?lines=200`

Live container logs of the deployed application. Useful when the
build succeeded but the running app misbehaves at runtime (5xx,
crash loops, missing env vars, etc.).

```json
{
  "repo": "mon-proto",
  "app_uuid": "...",
  "lines": 187,
  "logs": "<container stdout/stderr, tailed>"
}
```

### `GET /healthz`

Liveness probe — does not require auth.

## Authentication

All endpoints except `/healthz` require:

```
Authorization: Bearer <github-pat>
```

From a PM machine inside agent-vm:

```sh
curl -H "Authorization: Bearer $(gh auth token)" \
  https://coolify-logs.proto-beta.fr/runtime-logs/mon-proto
```

The proxy:

1. Reads the PAT from the header.
2. Calls `GET https://api.github.com/user/memberships/orgs/{GITHUB_ORG}`
   with that PAT.
3. Returns 200 only if the response shows `state: active`.

Membership decisions are cached for 5 minutes per token (configurable
via `MEMBERSHIP_CACHE_TTL_MS`) to avoid hammering the GitHub API.

The proxy resolves the Coolify app by matching `git_repository`
against `/{repo}` (suffix match), so the URL only needs the repo
name, not the full owner path.

## Deploy via Coolify

1. In Coolify, project `infra` (or a new one), create a new application
   from this repo (`betagouv-experimentations/coolify-logs-proxy`).
2. Build pack: **Dockerfile**.
3. Domain: `https://coolify-logs.proto-beta.fr`. Port: `3000`.
4. Environment variables (Settings → Environment Variables):
   - `COOLIFY_BASE_URL` = `https://coolify.proto-beta.fr`
   - `COOLIFY_TOKEN` = the **read-only** Coolify API token
   - `GITHUB_ORG` = `betagouv-experimentations` (optional, default)
5. Deploy.

## Local dev

```sh
bun install
cp .env.example .env
# edit .env with a real token
bun run dev
```

Then:

```sh
curl http://localhost:3000/healthz
curl http://localhost:3000/logs/template-proto/HEAD
```

## Why this exists

`/save` in agent-vm wants to know whether the user's last push built
successfully. Three options were considered:

- distribute a Coolify token to every PM machine (leak risk)
- give every PM a Coolify account (account sprawl, friction)
- expose a narrow, read-only proxy with the token server-side (this)

The proxy returns only build logs (no runtime logs, no DB credentials,
no environment variables) and only for repos already public on GitHub.
