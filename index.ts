// Read-only proxy in front of the Coolify API. Exposes:
//   GET /logs/{repo}/{sha}      → build/deploy status + last log lines
//   GET /runtime-logs/{repo}    → live container logs of the deployed app
//   GET /healthz                → liveness probe
//
// All endpoints except /healthz require an Authorization header with a
// GitHub PAT belonging to a member of GITHUB_ORG. The PM machine is
// already authenticated to GitHub through `gh auth login`, so callers
// pass `Authorization: Bearer $(gh auth token)`. No new credential to
// distribute, no shared secret on PM machines.

const COOLIFY_BASE_URL = requireEnv("COOLIFY_BASE_URL").replace(/\/$/, "");
const COOLIFY_TOKEN = requireEnv("COOLIFY_TOKEN");
const COOLIFY_TOKEN_WRITE = process.env.COOLIFY_TOKEN_WRITE ?? "";
const GITHUB_ORG = process.env.GITHUB_ORG ?? "betagouv-experimentations";
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 3000);
const LOG_LINES = Number(process.env.LOG_LINES ?? 200);
const APP_CACHE_TTL_MS = Number(process.env.APP_CACHE_TTL_MS ?? 5 * 60 * 1000);
const MEMBERSHIP_CACHE_TTL_MS = Number(
  process.env.MEMBERSHIP_CACHE_TTL_MS ?? 5 * 60 * 1000,
);

type CoolifyApp = {
  uuid: string;
  name?: string;
  git_repository?: string;
  project_uuid?: string;
  environment_name?: string;
};

type CoolifyDatabase = {
  uuid: string;
  name?: string;
  project_uuid?: string;
};

type DeploymentItem = {
  deployment_uuid?: string;
  status?: string;
  commit?: string;
  git_commit_sha?: string;
  commit_message?: string | null;
  created_at?: string;
  updated_at?: string;
  finished_at?: string | null;
  deployment_url?: string;
  logs?: string;
};

type LogEntry = {
  output?: string;
  type?: string;
  hidden?: boolean;
  timestamp?: string;
};

type AppCacheEntry = { apps: CoolifyApp[]; fetchedAt: number };
let appCache: AppCacheEntry | null = null;

type MembershipResult = { ok: boolean; checkedAt: number; login?: string };
const membershipCache = new Map<string, MembershipResult>();

class CoolifyError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: string,
  ) {
    super(`Coolify ${status} on ${path}: ${body}`);
  }
}

async function coolify<T>(
  path: string,
  init: { method?: string; token?: string } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const token = init.token ?? COOLIFY_TOKEN;
  const res = await fetch(`${COOLIFY_BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new CoolifyError(res.status, path, await res.text());
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

function parseCoolifyErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : null;
  } catch {
    return null;
  }
}

function unwrapList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["data", "deployments", "applications", "items", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

async function listApps(): Promise<CoolifyApp[]> {
  if (appCache && Date.now() - appCache.fetchedAt < APP_CACHE_TTL_MS) {
    return appCache.apps;
  }
  const raw = await coolify<unknown>("/api/v1/applications");
  const apps = unwrapList<CoolifyApp>(raw);
  appCache = { apps, fetchedAt: Date.now() };
  return apps;
}

function findAppByRepo(apps: CoolifyApp[], repo: string): CoolifyApp | undefined {
  const needle = `/${repo}`;
  return apps.find((a) => {
    const r = (a.git_repository ?? "").replace(/\.git$/, "").replace(/\/$/, "");
    return r.endsWith(needle);
  });
}

function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}

function deploymentSha(d: DeploymentItem): string | undefined {
  return d.git_commit_sha ?? d.commit;
}

function shaMatches(sha: string, query: string): boolean {
  if (!sha || !query) return false;
  return sha.startsWith(query) || query.startsWith(sha);
}

function flattenLogs(rawLogs: string | undefined, max: number): string {
  if (!rawLogs) return "";
  let entries: LogEntry[];
  try {
    const parsed = JSON.parse(rawLogs);
    if (!Array.isArray(parsed)) return tailLines(rawLogs, max);
    entries = parsed as LogEntry[];
  } catch {
    return tailLines(rawLogs, max);
  }
  const visible = entries
    .filter((e) => !e.hidden && typeof e.output === "string")
    .map((e) => e.output as string);
  return tailLines(visible.join("\n"), max);
}

async function handleBuildLogs(repo: string, sha: string): Promise<Response> {
  const apps = await listApps();
  const app = findAppByRepo(apps, repo);
  if (!app) {
    return Response.json({ status: "not_found", reason: "app" }, { status: 404 });
  }

  const rawList = await coolify<unknown>(
    `/api/v1/deployments/applications/${app.uuid}?take=20`,
  );
  const list = unwrapList<DeploymentItem>(rawList);
  const match =
    list.find((d) => shaMatches(deploymentSha(d) ?? "", sha)) ?? list[0];

  if (!match) {
    return Response.json({ status: "not_found", reason: "deployment" }, { status: 404 });
  }

  const deploymentPath = match.deployment_url ?? null;
  const absoluteDeploymentUrl = deploymentPath
    ? deploymentPath.startsWith("http")
      ? deploymentPath
      : `${COOLIFY_BASE_URL}${deploymentPath}`
    : null;

  return Response.json({
    status: match.status ?? null,
    commit: deploymentSha(match) ?? null,
    commit_message: match.commit_message ?? null,
    deployment_uuid: match.deployment_uuid ?? null,
    deployment_url: absoluteDeploymentUrl,
    started_at: match.created_at ?? null,
    updated_at: match.updated_at ?? null,
    finished_at: match.finished_at ?? null,
    logs: flattenLogs(match.logs, LOG_LINES),
  });
}

async function handleRuntimeLogs(repo: string, lines: number): Promise<Response> {
  const apps = await listApps();
  const app = findAppByRepo(apps, repo);
  if (!app) {
    return Response.json({ status: "not_found", reason: "app" }, { status: 404 });
  }

  let raw: unknown;
  try {
    raw = await coolify<unknown>(
      `/api/v1/applications/${app.uuid}/logs?lines=${lines}`,
    );
  } catch (err) {
    if (err instanceof CoolifyError && (err.status === 400 || err.status === 404)) {
      const message = parseCoolifyErrorMessage(err.body) ?? "Application is not running.";
      return Response.json(
        {
          status: "not_running",
          repo,
          app_uuid: app.uuid,
          message,
          hint: "The container is not currently running, so there are no live logs to read. Check the latest build logs via /logs/{repo}/{sha} for the failure cause.",
        },
        { status: 200 },
      );
    }
    throw err;
  }

  const logs =
    raw && typeof raw === "object" && "logs" in raw && typeof (raw as { logs?: unknown }).logs === "string"
      ? ((raw as { logs: string }).logs)
      : typeof raw === "string"
      ? raw
      : "";

  return Response.json({
    status: "running",
    repo,
    app_uuid: app.uuid,
    lines: logs.split(/\r?\n/).length,
    logs: tailLines(logs, lines),
  });
}

async function verifyMembership(token: string): Promise<MembershipResult> {
  const cached = membershipCache.get(token);
  if (cached && Date.now() - cached.checkedAt < MEMBERSHIP_CACHE_TTL_MS) {
    return cached;
  }
  let result: MembershipResult = { ok: false, checkedAt: Date.now() };
  try {
    const res = await fetch(
      `https://api.github.com/user/memberships/orgs/${GITHUB_ORG}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "coolify-logs-proxy",
        },
      },
    );
    if (res.ok) {
      const body = (await res.json()) as { state?: string; user?: { login?: string } };
      if (body.state === "active") {
        result = {
          ok: true,
          checkedAt: Date.now(),
          login: body.user?.login,
        };
      }
    }
  } catch (err) {
    console.error("membership check failed:", err);
  }
  membershipCache.set(token, result);
  return result;
}

function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

async function verifyGithubSignature(
  req: Request,
  rawBody: string,
): Promise<boolean> {
  if (!GITHUB_WEBHOOK_SECRET) return false;
  const header =
    req.headers.get("x-hub-signature-256") ?? req.headers.get("X-Hub-Signature-256");
  if (!header) return false;
  const expected = header.replace(/^sha256=/, "");

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const computed = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== computed.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ computed.charCodeAt(i);
  }
  return mismatch === 0;
}

async function handleRepositoryDeleted(
  repoName: string,
  fullName: string,
): Promise<{ ok: boolean; deletedApp: boolean; deletedDb: boolean; notes: string[] }> {
  const notes: string[] = [];
  if (!COOLIFY_TOKEN_WRITE) {
    notes.push("COOLIFY_TOKEN_WRITE not configured; refusing to delete.");
    return { ok: false, deletedApp: false, deletedDb: false, notes };
  }

  const apps = await listApps();
  const app = findAppByRepo(apps, repoName);

  let deletedApp = false;
  let deletedDb = false;

  if (!app) {
    notes.push(`No Coolify app found whose git_repository ends with /${repoName}.`);
  } else {
    notes.push(`Found app ${app.uuid} (${app.name ?? "?"}) for ${fullName}.`);
    try {
      await coolify(`/api/v1/applications/${app.uuid}/stop`, {
        method: "POST",
        token: COOLIFY_TOKEN_WRITE,
      });
    } catch (err) {
      notes.push(`Stop application failed (continuing): ${(err as Error).message}`);
    }
    try {
      await coolify(`/api/v1/applications/${app.uuid}`, {
        method: "DELETE",
        token: COOLIFY_TOKEN_WRITE,
      });
      deletedApp = true;
      notes.push("Application deleted.");
    } catch (err) {
      notes.push(`Delete application failed: ${(err as Error).message}`);
    }
  }

  // Find DBs whose name matches db-{repo-name} and that are in the same
  // project as the app (when we know the project).
  try {
    const rawDbs = await coolify<unknown>("/api/v1/databases");
    const dbs = unwrapList<CoolifyDatabase>(rawDbs);
    const expectedName = `db-${repoName}`;
    const candidates = dbs.filter((d) => {
      const nameMatches = d.name === expectedName;
      const projectMatches = !app?.project_uuid || d.project_uuid === app.project_uuid;
      return nameMatches && projectMatches;
    });

    if (candidates.length === 0) {
      notes.push(`No Coolify database found with name ${expectedName}.`);
    }

    for (const db of candidates) {
      try {
        await coolify(`/api/v1/databases/${db.uuid}/stop`, {
          method: "POST",
          token: COOLIFY_TOKEN_WRITE,
        });
      } catch (err) {
        notes.push(`Stop database ${db.uuid} failed (continuing): ${(err as Error).message}`);
      }
      try {
        await coolify(`/api/v1/databases/${db.uuid}`, {
          method: "DELETE",
          token: COOLIFY_TOKEN_WRITE,
        });
        deletedDb = true;
        notes.push(`Database ${db.uuid} (${db.name}) deleted.`);
      } catch (err) {
        notes.push(`Delete database ${db.uuid} failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    notes.push(`List databases failed: ${(err as Error).message}`);
  }

  // Invalidate the app cache so subsequent /logs calls don't hit the
  // deleted app.
  appCache = null;

  return { ok: deletedApp || deletedDb, deletedApp, deletedDb, notes };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const buildLogsPattern = /^\/logs\/([^/]+)\/([^/]+)\/?$/;
const runtimeLogsPattern = /^\/runtime-logs\/([^/]+)\/?$/;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/webhooks/github") {
      const rawBody = await req.text();
      const validSig = await verifyGithubSignature(req, rawBody);
      if (!validSig) {
        return Response.json(
          { error: "invalid_signature" },
          { status: 401 },
        );
      }
      const event = req.headers.get("x-github-event") ?? "";
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      const action = typeof payload.action === "string" ? payload.action : "";
      const repository = (payload.repository ?? {}) as {
        name?: string;
        full_name?: string;
      };

      if (event === "repository" && action === "deleted" && repository.name) {
        try {
          const result = await handleRepositoryDeleted(
            repository.name,
            repository.full_name ?? repository.name,
          );
          console.log(
            `repository.deleted ${repository.full_name}: app=${result.deletedApp} db=${result.deletedDb}`,
          );
          for (const n of result.notes) console.log(`  - ${n}`);
          return Response.json({ ok: result.ok, ...result });
        } catch (err) {
          console.error("webhook cleanup error:", err);
          return Response.json(
            { error: "cleanup_failed", message: (err as Error).message },
            { status: 502 },
          );
        }
      }

      // Acknowledge unrelated events so GitHub stops retrying.
      return Response.json({ ok: true, ignored: { event, action } });
    }

    if (req.method !== "GET") {
      return new Response("Not found", { status: 404 });
    }

    const buildMatch = buildLogsPattern.exec(url.pathname);
    const runtimeMatch = runtimeLogsPattern.exec(url.pathname);
    if (!buildMatch && !runtimeMatch) {
      return new Response("Not found", { status: 404 });
    }

    const token = extractBearer(req);
    if (!token) {
      return Response.json(
        {
          error: "missing_authorization",
          hint: `Pass 'Authorization: Bearer $(gh auth token)' — your GitHub PAT, used to verify membership in ${GITHUB_ORG}.`,
        },
        { status: 401 },
      );
    }
    const membership = await verifyMembership(token);
    if (!membership.ok) {
      return Response.json(
        {
          error: "forbidden",
          hint: `Token holder is not an active member of ${GITHUB_ORG}.`,
        },
        { status: 403 },
      );
    }

    try {
      if (buildMatch) {
        const repo = decodeURIComponent(buildMatch[1]!);
        const sha = decodeURIComponent(buildMatch[2]!);
        return await handleBuildLogs(repo, sha);
      }
      if (runtimeMatch) {
        const repo = decodeURIComponent(runtimeMatch[1]!);
        const lines = Math.min(
          Number(url.searchParams.get("lines") ?? LOG_LINES) || LOG_LINES,
          2000,
        );
        return await handleRuntimeLogs(repo, lines);
      }
    } catch (err) {
      console.error("handler error:", err);
      return Response.json(
        { status: "error", message: (err as Error).message },
        { status: 502 },
      );
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`coolify-logs-proxy listening on :${PORT}, gating ${GITHUB_ORG}`);
