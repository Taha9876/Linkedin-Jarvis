import { chromium, BrowserContext, Page } from "playwright-core";
import path from "path";
import fs from "fs/promises";
import { cookies } from "next/headers";
import * as bb from "./browserbase";
import * as sl from "./serverless-browser";

export type SessionStatus =
  | "disconnected"
  | "connecting"
  | "checkpoint" // LinkedIn wants 2FA / CAPTCHA — user solves it in the window / live view
  | "connected"
  | "error";

interface SessionState {
  context: BrowserContext | null;
  page: Page | null;
  status: SessionStatus;
  error: string | null;
  lastPosts: { urn: string; author: string; text: string }[];
}

/**
 * Two very different runtimes:
 *
 *  LOCAL  — we launch a visible Chrome and keep it in module memory. The dev
 *           server is one long-lived process, so that works.
 *
 *  REMOTE — on Vercel each request is a fresh, display-less sandbox with no
 *           memory of the last one, so we cannot own a browser. Chrome lives in
 *           Browserbase and we reconnect over CDP on every invocation. The
 *           session id travels in a cookie; the login lives in a Browserbase
 *           context. Post handles are re-read per request rather than cached.
 */
const REMOTE = bb.remoteEnabled();
const SERVERLESS = sl.serverlessEnabled();

const g = globalThis as unknown as {
  __jarvisSession?: SessionState;
  // In serverless mode a browser lives for exactly one request. It's opened on
  // first use and torn down by finishRequest(), so every tool in a single
  // command shares one browser instead of paying a cold start each.
  __jarvisEphemeral?: sl.Ephemeral | null;
};

/** Serverless only: close the per-request browser and persist auth + position. */
export async function finishRequest(): Promise<void> {
  const e = g.__jarvisEphemeral;
  g.__jarvisEphemeral = null;
  if (e) await e.finish();
}

function state(): SessionState {
  if (!g.__jarvisSession) {
    g.__jarvisSession = { context: null, page: null, status: "disconnected", error: null, lastPosts: [] };
  }
  return g.__jarvisSession;
}

const PROFILE_DIR = path.join(process.cwd(), ".linkedin-profile");
const SESSION_COOKIE = "jarvis_bb_session";
const CONTEXT_COOKIE = "jarvis_bb_context";
const POSTS_COOKIE = "jarvis_posts";

/* ------------------------------------------------------------------ */
/* Post handles                                                        */
/* ------------------------------------------------------------------ */

export async function getLastPosts() {
  if (!REMOTE && !SERVERLESS) return state().lastPosts;
  try {
    const raw = (await cookies()).get(POSTS_COOKIE)?.value;
    return raw ? (JSON.parse(decodeURIComponent(raw)) as SessionState["lastPosts"]) : [];
  } catch {
    return [];
  }
}

export async function setLastPosts(posts: { urn: string; author: string; text: string }[]) {
  if (!REMOTE && !SERVERLESS) {
    state().lastPosts = posts;
    return;
  }
  try {
    // keep it small — cookies cap at ~4KB
    const slim = posts.slice(0, 10).map((p) => ({ ...p, text: p.text.slice(0, 80) }));
    (await cookies()).set(POSTS_COOKIE, encodeURIComponent(JSON.stringify(slim)), {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 3600,
    });
  } catch {
    /* called outside a request scope — ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Connecting                                                          */
/* ------------------------------------------------------------------ */

function isLoggedInUrl(url: string) {
  return /linkedin\.com\/(feed|in\/|mynetwork|notifications|messaging|search|my-items)/.test(url);
}
function isCheckpointUrl(url: string) {
  return /checkpoint|challenge|captcha|verify/i.test(url);
}

async function readCookie(name: string): Promise<string | undefined> {
  try {
    return (await cookies()).get(name)?.value;
  } catch {
    return undefined;
  }
}
async function writeCookie(name: string, value: string) {
  try {
    (await cookies()).set(name, value, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 7 });
  } catch {
    /* not in a request scope */
  }
}

/** Reattach to (or create) the cloud browser and hand back its page. */
async function remotePage(create: boolean): Promise<Page | null> {
  let sessionId = await readCookie(SESSION_COOKIE);
  let contextId = await readCookie(CONTEXT_COOKIE);

  if (sessionId) {
    const live = await bb.getSession(sessionId);
    if (!live || live.status !== "RUNNING") sessionId = undefined; // it was recycled
  }

  if (!sessionId) {
    if (!create) return null;
    contextId = await bb.ensureContext(contextId);
    const s = await bb.createSession(contextId);
    sessionId = s.id;
    await writeCookie(SESSION_COOKIE, s.id);
    await writeCookie(CONTEXT_COOKIE, contextId);
  }

  const info = await bb.getSession(sessionId);
  if (!info?.connectUrl) throw new Error("Couldn't reach the cloud browser session.");

  const browser = await chromium.connectOverCDP(info.connectUrl);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return page;
}

async function localPage(): Promise<Page> {
  const s = state();
  if (s.context && s.page && !s.page.isClosed()) return s.page;

  const context = await launchLocal();
  const page = context.pages()[0] ?? (await context.newPage());
  context.on("close", () => {
    const st = state();
    st.context = null;
    st.page = null;
    st.status = "disconnected";
  });
  s.context = context;
  s.page = page;
  return page;
}

/**
 * Chromium refuses to start if another process still holds the profile
 * directory ("Opening in existing browser session") — which happens whenever a
 * previous run left a Chrome behind, or two dev servers are running at once.
 * That used to surface as "nothing happens when I click Connect", so instead of
 * failing we clear the stale lock files and retry once.
 */
async function launchLocal(): Promise<BrowserContext> {
  try {
    return await launchWithProfile();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/existing browser session|ProcessSingleton|already in use/i.test(msg)) throw e;

    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      await fs.rm(path.join(PROFILE_DIR, f), { force: true }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 800));
    try {
      return await launchWithProfile();
    } catch {
      throw new Error(
        "A previous Chrome is still holding the LinkedIn profile. Close any Chrome window Jarvis opened (and make sure only one dev server is running), then hit Connect again."
      );
    }
  }
}

function launchWithProfile(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chromium",
    viewport: { width: 1280, height: 850 },
    args: ["--disable-blink-features=AutomationControlled"],
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
}

export async function getPage(): Promise<Page> {
  if (SERVERLESS) {
    if (!(await sl.hasSession())) {
      throw new Error("LinkedIn is not connected. Connect your account first.");
    }
    if (!g.__jarvisEphemeral) g.__jarvisEphemeral = await sl.openEphemeral();
    return g.__jarvisEphemeral.page;
  }
  if (REMOTE) {
    const page = await remotePage(false);
    if (!page) throw new Error("LinkedIn is not connected. Connect your account first.");
    return page;
  }
  const s = state();
  if (!s.page || s.page.isClosed()) {
    throw new Error("LinkedIn is not connected. Connect your account first.");
  }
  return s.page;
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

export function getStatus(): { status: SessionStatus; error: string | null } {
  const s = state();
  return { status: s.status, error: s.error };
}

/** Look at the live browser and report what's actually on screen. */
export async function probeStatus(): Promise<{
  status: SessionStatus;
  error: string | null;
  liveViewUrl?: string | null;
  remote: boolean;
  cloud?: boolean;
}> {
  if (SERVERLESS) {
    // Cheap: just check whether we're holding a LinkedIn auth cookie. Launching
    // a browser merely to answer a 3-second poll would be absurd.
    return {
      status: (await sl.hasSession()) ? "connected" : "disconnected",
      error: null,
      remote: false,
      cloud: true, // no window will ever open — the UI must say so
    };
  }
  if (REMOTE) {
    const sessionId = await readCookie(SESSION_COOKIE);
    if (!sessionId) return { status: "disconnected", error: null, remote: true };
    try {
      const page = await remotePage(false);
      if (!page) return { status: "disconnected", error: null, remote: true };
      const url = page.url();
      if (isCheckpointUrl(url)) {
        return {
          status: "checkpoint",
          error: "LinkedIn wants a security check — solve it in the live view below.",
          liveViewUrl: await bb.liveViewUrl(sessionId),
          remote: true,
        };
      }
      if (isLoggedInUrl(url)) return { status: "connected", error: null, remote: true };
      return {
        status: "connecting",
        error: null,
        liveViewUrl: await bb.liveViewUrl(sessionId),
        remote: true,
      };
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : String(e), remote: true };
    }
  }

  const s = state();
  if (s.page && !s.page.isClosed()) {
    try {
      const url = s.page.url();
      if (isCheckpointUrl(url)) {
        s.status = "checkpoint";
        s.error = "LinkedIn wants a security check. Solve it in the Chrome window.";
      } else if (isLoggedInUrl(url)) {
        s.status = "connected";
        s.error = null;
      }
    } catch {
      /* mid-navigation */
    }
  }
  return { status: s.status, error: s.error, remote: false };
}

/* ------------------------------------------------------------------ */
/* Connect / disconnect                                                */
/* ------------------------------------------------------------------ */

export async function connect(email?: string, password?: string, liAt?: string): Promise<void> {
  if (SERVERLESS) return connectServerless(email, password, liAt);
  if (REMOTE) return connectRemote(email, password);
  return connectLocal(email, password);
}

/**
 * Serverless login. Must complete inside one invocation, so we log in and grab
 * the auth cookie right here — there's no browser left afterwards to finish in.
 * If LinkedIn throws a CAPTCHA or 2FA we cannot hand the user a window to solve
 * it in, so we say so plainly rather than hanging.
 */
async function connectServerless(email?: string, password?: string, liAt?: string): Promise<void> {
  // Preferred path in the cloud: adopt an existing LinkedIn session cookie.
  // Skips the login form entirely, so there's no CAPTCHA to solve in a browser
  // the user can't see — and their password never leaves their machine.
  if (liAt?.trim()) {
    await sl.adoptCookie(liAt);
    const e = await sl.openEphemeral("https://www.linkedin.com/feed/");
    g.__jarvisEphemeral = e;
    if (isLoggedInUrl(e.page.url())) return;
    await finishRequest();
    await sl.clearSession();
    throw new Error("That li_at cookie didn't work — it may be expired. Copy a fresh one.");
  }

  if (await sl.hasSession()) {
    const e = await sl.openEphemeral("https://www.linkedin.com/feed/");
    g.__jarvisEphemeral = e;
    if (isLoggedInUrl(e.page.url())) return;
    await finishRequest();
    await sl.clearSession(); // cookie was stale
  }

  if (!email || !password) {
    throw new Error("Enter your LinkedIn email and password to connect.");
  }

  const e = await sl.openEphemeral("https://www.linkedin.com/login");
  g.__jarvisEphemeral = e;
  const page = e.page;

  await page.waitForTimeout(1200);
  const user = page.locator("#username, input[name='session_key']").first();
  const pass = page.locator("#password, input[name='session_password']").first();
  if (await user.isVisible().catch(() => false)) await user.fill(email).catch(() => {});
  if (!(await pass.isVisible().catch(() => false))) {
    throw new Error("LinkedIn didn't show a login form. Try again in a moment.");
  }
  await pass.fill(password);
  await page.locator('button[type="submit"]').first().click({ timeout: 8000 }).catch(() => {});

  // wait for the feed, a challenge, or an error — up to ~30s, well inside the limit
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (isLoggedInUrl(url)) return; // finishRequest() persists li_at
    if (isCheckpointUrl(url)) {
      throw new Error(
        "LinkedIn is asking for a security check (CAPTCHA or a code). A serverless browser has no window for you to solve it in — run Jarvis locally to complete this challenge once, or set BROWSERBASE_API_KEY to get an interactive live view."
      );
    }
    const err = await page
      .locator("#error-for-password, #error-for-username, .form__label--error")
      .first()
      .textContent()
      .catch(() => null);
    if (err?.trim()) throw new Error(err.trim());
    await page.waitForTimeout(1500);
  }
  throw new Error("Timed out logging in to LinkedIn.");
}

/**
 * Remote connect must FINISH INSIDE ONE INVOCATION (Vercel kills the function
 * when the response is sent), so we don't sit and poll for the login here.
 * We navigate, attempt the credential fill, and return — the client then polls
 * /status, and the user finishes any 2FA/CAPTCHA in the live view.
 */
async function connectRemote(email?: string, password?: string): Promise<void> {
  const page = await remotePage(true);
  if (!page) throw new Error("Couldn't start the cloud browser.");

  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);
  if (isLoggedInUrl(page.url())) return; // context already had the login

  if (!email || !password) {
    throw new Error("No saved cloud session — enter your LinkedIn email and password.");
  }

  if (!page.url().includes("/login")) {
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1200);
  }
  const user = page.locator("#username, input[name='session_key']").first();
  const pass = page.locator("#password, input[name='session_password']").first();
  if (await user.isVisible().catch(() => false)) await user.fill(email).catch(() => {});
  if (await pass.isVisible().catch(() => false)) {
    await pass.fill(password);
    await page.locator('button[type="submit"]').first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  // whatever state we land in, /status + the live view take it from here
}

async function connectLocal(email?: string, password?: string): Promise<void> {
  const s = state();
  if (s.status === "connecting") return;
  s.status = "connecting";
  s.error = null;

  try {
    const page = await localPage();
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);

    if (isLoggedInUrl(page.url())) {
      s.status = "connected";
      return;
    }
    if (!email || !password) {
      s.status = "error";
      s.error =
        "No saved session found — enter your email and password, or just log in directly in the Chrome window (I'll detect it).";
      return;
    }
    if (!page.url().includes("/login")) {
      await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);
    }
    try {
      const remembered = page.locator(".member-profile-block, button.member-profile__details").first();
      if (await remembered.isVisible().catch(() => false)) {
        await remembered.click().catch(() => {});
        await page.waitForTimeout(1200);
      }
      const user = page.locator("#username, input[name='session_key']").first();
      const pass = page.locator("#password, input[name='session_password']").first();
      if (await user.isVisible().catch(() => false)) await user.fill(email, { timeout: 5000 }).catch(() => {});
      if (await pass.isVisible().catch(() => false)) {
        await pass.fill(password, { timeout: 5000 });
        await page.waitForTimeout(400);
        await page
          .locator('button[type="submit"], button[data-litms-control-urn="login-submit"]')
          .first()
          .click({ timeout: 5000 })
          .catch(() => {});
        await page.waitForTimeout(3000);
      }
    } catch {
      /* user finishes manually in the window */
    }

    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const url = page.url();
      if (isLoggedInUrl(url)) {
        s.status = "connected";
        return;
      }
      if (isCheckpointUrl(url)) s.status = "checkpoint";
      await page.waitForTimeout(2000);
    }
    s.status = "error";
    s.error = "Timed out waiting for login. Try again.";
  } catch (e) {
    s.status = "error";
    s.error = e instanceof Error ? e.message : String(e);
  }
}

export async function disconnect(): Promise<void> {
  if (SERVERLESS) {
    await finishRequest();
    await sl.clearSession();
    return;
  }
  if (REMOTE) {
    const id = await readCookie(SESSION_COOKIE);
    if (id) await bb.releaseSession(id);
    try {
      (await cookies()).delete(SESSION_COOKIE);
    } catch {
      /* ignore */
    }
    return;
  }
  const s = state();
  await s.context?.close().catch(() => {});
  s.context = null;
  s.page = null;
  s.status = "disconnected";
  s.error = null;
}

export function isRemote(): boolean {
  return REMOTE;
}

export function isServerless(): boolean {
  return SERVERLESS;
}
