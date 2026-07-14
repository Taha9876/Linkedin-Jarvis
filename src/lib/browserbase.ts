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

function creds() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  return { apiKey, projectId };
}

export function remoteEnabled(): boolean {
  return creds() !== null;
}

interface SessionInfo {
  id: string;
  connectUrl: string;
  contextId: string;
}

async function bb(path: string, init: RequestInit = {}) {
  const c = creds();
  if (!c) throw new Error("Browserbase is not configured.");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "X-BB-API-Key": c.apiKey,
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
  const c = creds()!;
  const ctx = await bb("/contexts", {
    method: "POST",
    body: JSON.stringify({ projectId: c.projectId }),
  });
  return ctx.id as string;
}

export async function createSession(contextId: string): Promise<SessionInfo> {
  const c = creds()!;
  const s = await bb("/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId: c.projectId,
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
  const c = creds()!;
  await bb(`/sessions/${id}`, {
    method: "POST",
    body: JSON.stringify({ projectId: c.projectId, status: "REQUEST_RELEASE" }),
  }).catch(() => {});
}
