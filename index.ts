// Public read-only proxy that exposes a single endpoint:
//   GET /logs/{repo}/{sha}
// returning the Coolify build/deploy status and last log lines for that
// commit on the app whose Coolify "git_repository" ends in `/{repo}`.
//
// The Coolify token lives only in this process. Callers (Claude Code in
// agent-vm, /save) do not need any credential.

const COOLIFY_BASE_URL = requireEnv("COOLIFY_BASE_URL").replace(/\/$/, "");
const COOLIFY_TOKEN = requireEnv("COOLIFY_TOKEN");
const PORT = Number(process.env.PORT ?? 3000);
const LOG_LINES = Number(process.env.LOG_LINES ?? 200);
const APP_CACHE_TTL_MS = Number(process.env.APP_CACHE_TTL_MS ?? 5 * 60 * 1000);

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

function shaMatches(deploymentSha: string, query: string): boolean {
  if (!deploymentSha || !query) return false;
  return deploymentSha.startsWith(query) || query.startsWith(deploymentSha);
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

async function handleLogs(repo: string, sha: string): Promise<Response> {
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const logsPattern = /^\/logs\/([^/]+)\/([^/]+)\/?$/;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    const m = req.method === "GET" ? logsPattern.exec(url.pathname) : null;
    if (m) {
      const repo = decodeURIComponent(m[1]!);
      const sha = decodeURIComponent(m[2]!);
      try {
        return await handleLogs(repo, sha);
      } catch (err) {
        console.error("logs handler error:", err);
        return Response.json(
          { status: "error", message: (err as Error).message },
          { status: 502 },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`coolify-logs-proxy listening on :${PORT}`);
