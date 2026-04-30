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
const GITHUB_ORG = process.env.GITHUB_ORG ?? "betagouv-experimentations";
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

async function coolify<T>(path: string): Promise<T> {
  const res = await fetch(`${COOLIFY_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${COOLIFY_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Coolify ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
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

  const raw = await coolify<{ logs?: string } | unknown>(
    `/api/v1/applications/${app.uuid}/logs?lines=${lines}`,
  );
  const logs =
    raw && typeof raw === "object" && "logs" in raw && typeof (raw as { logs?: unknown }).logs === "string"
      ? ((raw as { logs: string }).logs)
      : typeof raw === "string"
      ? raw
      : "";

  return Response.json({
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
