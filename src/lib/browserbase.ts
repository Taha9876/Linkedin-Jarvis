/**
 * Cloud browser (Browserbase) — this is what makes a real Vercel deploy work.
 *
 * Serverless functions are stateless and have no display, so they can't OWN a
 * browser. Instead a Chrome instance lives in Browserbase and each function
 * invocation reconnects to it over CDP. Two things make that survivable:
 *
 *  - `keepAlive`: the session stays open between our requests instead of dying
 *    when the function returns.
 *  - a persistent `context`: cookies/localStorage are saved, so the LinkedIn
 *    login survives even if the session itself is later recycled. This is the
 *    cloud equivalent of the local `.linkedin-profile/` directory.
 *
 * The session id is handed back to the browser in a cookie, which is how one
 * invocation tells the next one which Chrome to reattach to.
 */

const API = "https://api.browserbase.com/v1";

export function remoteEnabled(): boolean {
  return !!process.env.BROWSERBASE_API_KEY;
}

function apiKey(): string {
  const k = process.env.BROWSERBASE_API_KEY;
  if (!k) throw new Error("Browserbase is not configured.");
  return k;
}

// The REST API needs a projectId in the body, but the user only supplies the
// API key — so we resolve the (single) project from the key once and cache it.
// This is what lets the whole thing run on one env var.
let cachedProjectId: string | null = null;
async function projectId(): Promise<string> {
  if (cachedProjectId) return cachedProjectId;
  const projects = await bb("/projects");
  const first = Array.isArray(projects) ? projects[0] : null;
  if (!first?.id) throw new Error("No Browserbase project found for this API key.");
  cachedProjectId = first.id as string;
  return cachedProjectId;
}

interface SessionInfo {
  id: string;
  connectUrl: string;
  contextId: string;
}

async function bb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "X-BB-API-Key": apiKey(),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Browserbase ${path} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * A persistent context holds the LinkedIn cookies. We create one on first use
 * and then reuse its id forever, so the user only ever logs in once.
 */
export async function ensureContext(existing?: string): Promise<string> {
  if (existing) return existing;
  const ctx = await bb("/contexts", {
    method: "POST",
    body: JSON.stringify({ projectId: await projectId() }),
  });
  return ctx.id as string;
}

export async function createSession(contextId: string): Promise<SessionInfo> {
  const s = await bb("/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId: await projectId(),
      // survive between serverless invocations instead of dying with the function
      keepAlive: true,
      browserSettings: {
        // persist=true writes cookies back to the context, so the login sticks
        context: { id: contextId, persist: true },
        viewport: { width: 1280, height: 850 },
        solveCaptchas: true,
      },
    }),
  });
  return { id: s.id as string, connectUrl: s.connectUrl as string, contextId };
}

export async function getSession(id: string): Promise<{ status: string; connectUrl?: string } | null> {
  try {
    const s = await bb(`/sessions/${id}`);
    return { status: s.status as string, connectUrl: s.connectUrl as string | undefined };
  } catch {
    return null;
  }
}

/** URL of the interactive live view — this is how the user solves CAPTCHAs. */
export async function liveViewUrl(id: string): Promise<string | null> {
  try {
    const r = await bb(`/sessions/${id}/debug`);
    return (r.debuggerFullscreenUrl as string) ?? (r.debuggerUrl as string) ?? null;
  } catch {
    return null;
  }
}

export async function releaseSession(id: string): Promise<void> {
  await bb(`/sessions/${id}`, {
    method: "POST",
    body: JSON.stringify({ projectId: await projectId(), status: "REQUEST_RELEASE" }),
  }).catch(() => {});
}
