import { chromium, BrowserContext, Page } from "playwright";
import path from "path";

export type SessionStatus =
  | "disconnected"
  | "connecting"
  | "checkpoint" // LinkedIn is asking for 2FA / verification in the visible window
  | "connected"
  | "error";

interface SessionState {
  context: BrowserContext | null;
  page: Page | null;
  status: SessionStatus;
  error: string | null;
  // urn -> stable handle for posts the agent has "seen", so voice commands
  // like "like the second post" resolve to a real DOM node
  lastPosts: { urn: string; author: string; text: string }[];
}

// Survive Next.js dev-server HMR: keep the browser on globalThis
const g = globalThis as unknown as { __jarvisSession?: SessionState };

function state(): SessionState {
  if (!g.__jarvisSession) {
    g.__jarvisSession = {
      context: null,
      page: null,
      status: "disconnected",
      error: null,
      lastPosts: [],
    };
  }
  return g.__jarvisSession;
}

const PROFILE_DIR = path.join(process.cwd(), ".linkedin-profile");

export function getStatus(): { status: SessionStatus; error: string | null } {
  const s = state();
  return { status: s.status, error: s.error };
}

/**
 * Look at the live browser window and update the status from what's actually
 * on screen. This is what lets a manual login (user types credentials or
 * solves a checkpoint directly in Chrome) get picked up automatically.
 */
export async function probeStatus(): Promise<{ status: SessionStatus; error: string | null }> {
  const s = state();
  if (s.page && !s.page.isClosed()) {
    try {
      const url = s.page.url();
      if (isCheckpointUrl(url)) {
        // can happen mid-session (CAPTCHA) — must override a "connected" status
        s.status = "checkpoint";
        s.error = "LinkedIn wants a security check. Solve it in the Chrome window.";
      } else if (isLoggedInUrl(url)) {
        s.status = "connected";
        s.error = null;
      }
    } catch {
      /* page busy navigating — keep last known status */
    }
  }
  return { status: s.status, error: s.error };
}

export function getLastPosts() {
  return state().lastPosts;
}

export function setLastPosts(posts: { urn: string; author: string; text: string }[]) {
  state().lastPosts = posts;
}

export async function getPage(): Promise<Page> {
  const s = state();
  if (!s.page || s.page.isClosed()) {
    throw new Error("LinkedIn is not connected. Connect your account first.");
  }
  return s.page;
}

async function ensureBrowser(): Promise<Page> {
  const s = state();
  if (s.context && s.page && !s.page.isClosed()) return s.page;

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 850 },
    args: ["--disable-blink-features=AutomationControlled"],
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
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

function isLoggedInUrl(url: string) {
  return (
    url.includes("linkedin.com/feed") ||
    url.includes("linkedin.com/in/") ||
    url.includes("linkedin.com/mynetwork") ||
    url.includes("linkedin.com/notifications") ||
    url.includes("linkedin.com/messaging") ||
    url.includes("linkedin.com/search")
  );
}

function isCheckpointUrl(url: string) {
  return /checkpoint|challenge|captcha|verify/i.test(url);
}

/**
 * Connect to LinkedIn. If a saved session exists in the persistent profile,
 * credentials are not needed at all. If LinkedIn throws a 2FA/verification
 * checkpoint, status becomes "checkpoint" and the user finishes it in the
 * visible Chrome window; we poll until the feed is reachable.
 */
export async function connect(email?: string, password?: string): Promise<void> {
  const s = state();
  if (s.status === "connecting") return;
  s.status = "connecting";
  s.error = null;

  try {
    const page = await ensureBrowser();
    await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2500);

    if (isLoggedInUrl(page.url())) {
      s.status = "connected";
      return;
    }

    // Need a fresh login
    if (!email || !password) {
      s.status = "error";
      s.error =
        "No saved session found — enter your email and password, or just log in directly in the Chrome window (I'll detect it).";
      return;
    }

    if (!page.url().includes("/login")) {
      await page.goto("https://www.linkedin.com/login", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(1500);
    }

    // Best effort auto-fill. LinkedIn serves several login variants (classic
    // form, "Welcome back" remembered account, join-form with different ids),
    // so a missing field is NOT fatal — the user can always finish the login
    // in the visible window and the wait loop below will pick it up.
    try {
      // "Welcome back" screen: click the remembered profile to reveal password
      const rememberedProfile = page.locator(".member-profile-block, button.member-profile__details").first();
      if (await rememberedProfile.isVisible().catch(() => false)) {
        await rememberedProfile.click().catch(() => {});
        await page.waitForTimeout(1200);
      }

      const userField = page.locator("#username, input[name='session_key']").first();
      const passField = page.locator("#password, input[name='session_password']").first();
      if (await userField.isVisible().catch(() => false)) {
        await userField.fill(email, { timeout: 5000 }).catch(() => {});
      }
      if (await passField.isVisible().catch(() => false)) {
        await passField.fill(password, { timeout: 5000 });
        await page.waitForTimeout(400);
        await page
          .locator('button[type="submit"], button[data-litms-control-urn="login-submit"]')
          .first()
          .click({ timeout: 5000 })
          .catch(() => {});
        await page.waitForTimeout(3000);
      }
    } catch {
      // auto-fill failed — the user finishes login manually in the window
    }

    // Wait up to 5 minutes for the feed — covers autofill success, manual
    // login, and checkpoints the user resolves in the window
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const url = page.url();
      if (isLoggedInUrl(url)) {
        s.status = "connected";
        return;
      }
      if (isCheckpointUrl(url)) {
        s.status = "checkpoint";
      } else if (url.includes("/login")) {
        const err = await page
          .locator("#error-for-password, #error-for-username, .form__label--error")
          .first()
          .textContent()
          .catch(() => null);
        if (err && err.trim()) {
          s.status = "error";
          s.error = err.trim();
          return;
        }
      }
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
  const s = state();
  await s.context?.close().catch(() => {});
  s.context = null;
  s.page = null;
  s.status = "disconnected";
  s.error = null;
}
