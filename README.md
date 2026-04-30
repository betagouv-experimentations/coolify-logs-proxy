# coolify-logs-proxy

Tiny public read-only proxy in front of the Coolify API. Lets Claude Code
(running in agent-vm on a PM's machine) fetch the build/deploy status
and recent logs for a given repo+commit, without ever giving the PM a
Coolify token.

The token lives only in this service's environment.

## Endpoint

```
GET /logs/{repo}/{sha}
```

Returns:

```json
{
  "status": "in_progress" | "finished" | "failed" | ...,
  "commit": "abc123...",
  "commit_message": "feat: add partner search",
  "deployment_url": "https://...",
  "started_at": "2026-04-30T15:00:00Z",
  "updated_at": "2026-04-30T15:02:30Z",
  "logs": "<last 200 lines>"
}
```

Plus `GET /healthz` for liveness checks.

The proxy resolves the Coolify app by matching `git_repository` against
`/{repo}` (suffix match), so the URL only needs the repo name, not the
full owner path.

## Deploy via Coolify

1. In Coolify, project `infra` (or a new one), create a new application
   from this repo (`betagouv-experimentations/coolify-logs-proxy`).
2. Build pack: **Dockerfile**.
3. Domain: `https://coolify-logs.proto-beta.fr`. Port: `3000`.
4. Environment variables (Settings → Environment Variables):
   - `COOLIFY_BASE_URL` = `https://coolify.proto-beta.fr`
   - `COOLIFY_TOKEN` = the **read-only** Coolify API token
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
