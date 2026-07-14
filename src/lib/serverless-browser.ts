import { chromium, Browser, Page } from "playwright-core";
import { cookies } from "next/headers";

/**
 * Serverless browser — a real Vercel deploy with NO third-party browser service.
 *
 * Chromium is bundled into the function itself (@sparticuz/chromium). The catch
 * is that a Vercel function is stateless: the browser is born and dies inside a
 * single request. So the things that normally live in a long-running browser
 * have to be carried between requests ourselves:
 *
 *   - LinkedIn's auth cookies  → an httpOnly cookie on our own domain
 *   - the page you were on     → same cookie
 *   - how far you'd scrolled   → same cookie
 *
 * Every request therefore: launch → restore cookies → navigate back to where you
 * were → restore scroll → do the thing → save the new state → close.
 *
 * That restore/teardown is real overhead (a second or two per action), which is
 * why local mode stays the fast path. But it needs no API keys and no PC.
 */

const STATE_COOKIE = "jarvis_li"; // LinkedIn auth cookies
const PLACE_COOKIE = "jarvis_place"; // url + scroll offset

// Only the cookies LinkedIn actually needs to keep you signed in. The full jar
// blows past the 4KB browser cookie limit; li_at alone is the session.
const AUTH_COOKIE_NAMES = ["li_at", "JSESSIONID", "liap", "li_rm"];

export interface Place {
  url: string;
  scrollY: number;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export function serverlessEnabled(): boolean {
  // Any serverless runtime, unless a remote browser service is configured.
  return (
    !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY) &&
    !process.env.BROWSERBASE_API_KEY
  );
}

/* ---------------- state carried between invocations ---------------- */

async function readJson<T>(name: string): Promise<T | null> {
  try {
    const raw = (await cookies()).get(name)?.value;
    return raw ? (JSON.parse(decodeURIComponent(raw)) as T) : null;
  } catch {
    return null;
  }
}

async function writeJson(name: string, value: unknown) {
  try {
    (await cookies()).set(name, encodeURIComponent(JSON.stringify(value)), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 14,
    });
  } catch {
    /* outside a request scope */
  }
}

/**
 * Escape hatch for the CAPTCHA problem.
 *
 * A serverless browser has no window, so if LinkedIn challenges the login there
 * is nowhere for the user to solve it — and it *will* challenge, because Vercel
 * runs on datacenter IPs. So we let them skip logging in entirely: paste the
 * `li_at` cookie from a browser where they're already signed in, and we adopt
 * that session. No password ever reaches the cloud.
 */
export function seededCookie(): string | null {
  return process.env.LINKEDIN_LI_AT?.trim() || null;
}

export async function adoptCookie(liAt: string) {
  await writeJson(STATE_COOKIE, [
    { name: "li_at", value: liAt.trim(), domain: ".linkedin.com", path: "/" },
  ]);
}

export async function hasSession(): Promise<boolean> {
  const jar = await readJson<StoredCookie[]>(STATE_COOKIE);
  if (jar?.some((c) => c.name === "li_at" && c.value)) return true;
  return !!seededCookie();
}

export async function clearSession() {
  try {
    const c = await cookies();
    c.delete(STATE_COOKIE);
    c.delete(PLACE_COOKIE);
  } catch {
    /* ignore */
  }
}

/* ---------------- the per-request browser ---------------- */

export interface Ephemeral {
  browser: Browser;
  page: Page;
  /** Persist auth + position, then tear the browser down. Always call this. */
  finish(): Promise<void>;
}

export async function openEphemeral(startUrl?: string): Promise<Ephemeral> {
  // Imported lazily: the module resolves an AWS-specific binary and must never
  // be pulled in during local dev or the build's static analysis pass.
  const mod = await import("@sparticuz/chromium");
  const pack = mod.default ?? mod;

  const browser = await chromium.launch({
    args: [...pack.args, "--disable-blink-features=AutomationControlled"],
    executablePath: await pack.executablePath(),
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 850 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });

  // Prefer the cookie jar we've saved; fall back to an operator-seeded li_at.
  const seed = seededCookie();
  const jar =
    (await readJson<StoredCookie[]>(STATE_COOKIE)) ??
    (seed ? [{ name: "li_at", value: seed, domain: ".linkedin.com", path: "/" }] : null);

  if (jar?.length) {
    await context
      .addCookies(
        jar.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || ".linkedin.com",
          path: c.path || "/",
          secure: true,
          httpOnly: true,
        }))
      )
      .catch(() => {});
  }

  const page = await context.newPage();

  const place = await readJson<Place>(PLACE_COOKIE);
  const target = startUrl ?? place?.url ?? "https://www.linkedin.com/feed/";
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

  // put the user back where they were — otherwise every command would silently
  // jump them to the top of the feed
  if (!startUrl && place?.scrollY) {
    await page.evaluate((y) => window.scrollTo(0, y), place.scrollY).catch(() => {});
    await page.waitForTimeout(400);
  }

  const finish = async () => {
    try {
      const all = await context.cookies("https://www.linkedin.com");
      const keep = all
        .filter((c) => AUTH_COOKIE_NAMES.includes(c.name))
        .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
      if (keep.length) await writeJson(STATE_COOKIE, keep);

      const url = page.url();
      const scrollY = await page.evaluate(() => window.scrollY).catch(() => 0);
      await writeJson(PLACE_COOKIE, { url, scrollY });
    } catch {
      /* best effort — never fail the user's action over bookkeeping */
    }
    await browser.close().catch(() => {});
  };

  return { browser, page, finish };
}
