import { Page } from "playwright";
import { getPage, getLastPosts, setLastPosts } from "./session";
import { cancelled, interruptibleSleep } from "./cancel";

/**
 * LinkedIn rolled out a new React UI (componentkey/aria-label based markup).
 * Everything here targets stable accessibility attributes:
 *   - post menu:  button[aria-label^="Open control menu for post by {author}"]
 *   - reaction:   button[aria-label^="Reaction button state: {state}"]
 *   - tray:       button[aria-label="Open reactions menu"]
 *   - comment:    button[aria-label="Comment"], editor [aria-label="Text editor for creating comment"]
 *   - text body:  [data-testid="expandable-text-box"] (+ expandable-text-button for "see more")
 * During read_visible_posts we stamp each post root with data-jarvis-post="<id>"
 * so follow-up actions ("like the second post") find the exact same node.
 */

export interface VisiblePost {
  index: number;
  id: string;
  author: string;
  text: string;
  reactionState: string; // "no reaction" | "Like" | "Celebrate" | ...
  reactions: string;
  comments: string;
}

const MENU_BTN = 'button[aria-label^="Open control menu for post by"]';

// Kept short — LinkedIn's own UI is the slow part, and the user wants snappy
// responses. Pacing that actually matters (write-action spacing) lives in agent.ts.
async function humanPause(page: Page, min = 200, max = 450) {
  await page.waitForTimeout(min + Math.random() * (max - min));
}

/**
 * LinkedIn's new UI has an overlay layer that fails Playwright's pointer
 * hit-testing ("<html> intercepts pointer events"), so a normal click times
 * out. `force: true` skips the hit-test and still delivers REAL browser
 * pointer events — which React requires.
 *
 * Do NOT swap this for element.click(): a synthetic DOM click is ignored by
 * LinkedIn's reaction/comment handlers, so actions appear to succeed while
 * nothing actually happens.
 */
async function jsClick(locator: ReturnType<Page["locator"]>): Promise<void> {
  const el = locator.first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await el.click({ force: true, timeout: 8000 });
  } catch {
    // last resort for elements Playwright can't reach at all (e.g. aria-hidden)
    await el.evaluate((n) => (n as HTMLElement).click());
  }
}

async function focusEditor(locator: ReturnType<Page["locator"]>): Promise<void> {
  await locator.first().evaluate((n) => (n as HTMLElement).focus());
}

async function dismissOverlays(page: Page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
}

/**
 * Click a visible control whose text matches `pattern`. LinkedIn's dropdown
 * items are plain buttons without menu roles, so text matching is the only
 * reliable handle. Skips the hidden video.js dialogs that litter the feed.
 */
async function pickByText(page: Page, pattern: RegExp): Promise<string | null> {
  const found = await page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const nodes = Array.from(
      document.querySelectorAll('button, [role="menuitem"], [role="button"], a')
    ) as HTMLElement[];
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue; // hidden (e.g. video.js modals)
      // icon-only controls (the reaction tray) carry their name in aria-label
      const label = (n.getAttribute("aria-label") || "").trim();
      const t = (n.innerText || n.textContent || "").replace(/\s+/g, " ").trim();
      const candidate = [t, label].find((c) => c && c.length < 40 && re.test(c));
      if (candidate) {
        n.setAttribute("data-jarvis-pick", "1");
        return candidate;
      }
    }
    return null;
  }, pattern.source);
  if (!found) return null;
  await jsClick(page.locator('[data-jarvis-pick="1"]'));
  await page
    .evaluate(() => document.querySelector('[data-jarvis-pick="1"]')?.removeAttribute("data-jarvis-pick"))
    .catch(() => {});
  return found;
}

/**
 * LinkedIn interrupts automated-looking sessions with a CAPTCHA / security
 * checkpoint. Every action checks for it so the agent can tell the user to
 * solve it in the Chrome window instead of silently doing nothing.
 */
async function assertNoCheckpoint(page: Page): Promise<void> {
  const url = page.url();
  if (/checkpoint|challenge|captcha|login-challenge/i.test(url)) {
    throw new Error(
      "LinkedIn is showing a security checkpoint (CAPTCHA) in the Chrome window. Please solve it there, then ask me again. Slowing down between actions helps avoid this."
    );
  }
  if (url.includes("/login") || url.includes("/uas/login")) {
    throw new Error("LinkedIn signed you out. Reconnect your account from the dashboard.");
  }
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

export async function goHome(): Promise<string> {
  const page = await getPage();
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await humanPause(page, 400, 700);
  return "On the LinkedIn home feed.";
}

export async function openNotifications(): Promise<string> {
  const page = await getPage();
  await page.goto("https://www.linkedin.com/notifications/", { waitUntil: "domcontentloaded" });
  await humanPause(page, 900, 1400);
  const items = await page
    .evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll("main article, main [role='listitem'], main li")
      )
        .map((n) => (n.textContent || "").replace(/\s+/g, " ").trim())
        .filter((t) => t.length > 20 && t.length < 400);
      return Array.from(new Set(rows)).slice(0, 8);
    })
    .catch(() => [] as string[]);
  if (!items.length) {
    const text = await page
      .evaluate(() => (document.querySelector("main") as HTMLElement | null)?.innerText.slice(0, 800) ?? "")
      .catch(() => "");
    return text
      ? `Notifications page content: ${text.replace(/\s+/g, " ")}`
      : "Notifications page is open, but I couldn't read any items.";
  }
  return "Latest notifications:\n" + items.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

export async function search(
  query: string,
  kind: "all" | "people" | "posts" | "companies" | "jobs"
): Promise<string> {
  const page = await getPage();
  const map: Record<string, string> = {
    all: "all",
    people: "people",
    posts: "content",
    companies: "companies",
    jobs: "jobs",
  };
  const url =
    kind === "jobs"
      ? `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(query)}`
      : `https://www.linkedin.com/search/results/${map[kind] ?? "all"}/?keywords=${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await humanPause(page, 900, 1400);

  // Content (posts) results render like the feed — reuse the post reader
  if (kind === "posts") {
    const posts = await readVisiblePostsInternal(page);
    if (posts.length) {
      setLastPosts(posts.map((p) => ({ urn: p.id, author: p.author, text: p.text })));
      return formatPosts(posts, `Post results for "${query}"`);
    }
  }

  const results = await page
    .evaluate(() => {
      const seen = new Set<string>();
      const out: string[] = [];
      const anchors = Array.from(
        document.querySelectorAll(
          'main a[href*="/in/"], main a[href*="/company/"], main a[href*="/jobs/view/"], main a[href*="/school/"]'
        )
      );
      for (const a of anchors) {
        // climb to the result card to capture name + headline together
        let card: HTMLElement | null = a as HTMLElement;
        for (let i = 0; i < 6 && card; i++) {
          if ((card.textContent || "").length > 60) break;
          card = card.parentElement;
        }
        const text = (card?.textContent || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 220);
        if (text.length > 25 && !seen.has(text.slice(0, 60))) {
          seen.add(text.slice(0, 60));
          out.push(text);
        }
        if (out.length >= 6) break;
      }
      return out;
    })
    .catch(() => [] as string[]);

  if (!results.length) {
    const text = await page
      .evaluate(() => (document.querySelector("main") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").slice(0, 700) ?? "")
      .catch(() => "");
    return `Searched for "${query}". Page shows: ${text || "(couldn't read results)"}`;
  }
  return `Top results for "${query}":\n` + results.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

export async function openProfile(name: string): Promise<string> {
  const page = await getPage();
  if (/^(me|my profile|myself)$/i.test(name.trim())) {
    await page.goto(await getOwnProfileUrl(page), { waitUntil: "domcontentloaded" });
  } else {
    await page.goto(
      `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name)}`,
      { waitUntil: "domcontentloaded" }
    );
    const first = page.locator('main a[href*="/in/"]').first();
    // search results stream in — wait for the first profile link to render
    await first.waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
    if ((await first.count()) === 0) return `Couldn't find anyone named "${name}".`;
    await humanPause(page, 350, 650);
    const href = await first.getAttribute("href");
    if (href) {
      await page.goto(new URL(href, "https://www.linkedin.com").toString(), {
        waitUntil: "domcontentloaded",
      });
    } else {
      await jsClick(first);
    }
  }
  await page.waitForLoadState("domcontentloaded");
  await humanPause(page, 900, 1400);
  return readProfile();
}

export async function readProfile(): Promise<string> {
  const page = await getPage();
  // The new profile page has no <h1> — the name is simply the first line of main.
  await page.locator("main").first().waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
  await humanPause(page, 600, 1000);
  const info = await page
    .evaluate(() => {
      const lines = ((document.querySelector("main") as HTMLElement | null)?.innerText ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 1 && !/^(Add verification badge|Open to|More)$/i.test(l));
      return { name: lines[0] ?? "", summary: lines.slice(0, 25).join(" · ").slice(0, 900) };
    })
    .catch(() => null);
  if (!info?.name) return "A profile page is open but I couldn't read it.";
  return `Profile of ${info.name}: ${info.summary}`;
}

/* ------------------------------------------------------------------ */
/* Feed reading & scrolling                                            */
/* ------------------------------------------------------------------ */

/**
 * Scroll the feed. "slow" glides in small increments with pauses so the user
 * can read along and say "stop" — which lands mid-scroll, because every step
 * checks the cancel flag rather than running to completion.
 */
export async function scroll(
  direction: "down" | "up",
  amount: number,
  speed: "slow" | "normal" | "fast" = "normal"
): Promise<string> {
  const page = await getPage();
  const sign = direction === "down" ? 1 : -1;

  const plan = {
    slow: { steps: Math.min(Math.max(amount, 1), 30) * 6, px: 90, gap: 220 },
    normal: { steps: Math.min(Math.max(amount, 1), 10), px: 700, gap: 300 },
    fast: { steps: Math.min(Math.max(amount, 1), 10), px: 1400, gap: 120 },
  }[speed];

  let done = 0;
  for (let i = 0; i < plan.steps; i++) {
    if (cancelled()) break;
    await page.mouse.wheel(0, sign * plan.px);
    done++;
    if (!(await interruptibleSleep(plan.gap))) break;
  }

  if (cancelled()) {
    const pct = Math.round((done / plan.steps) * 100);
    return `Stopped scrolling (about ${pct}% of the way).`;
  }
  return speed === "slow"
    ? `Scrolled slowly ${direction}. Say stop any time.`
    : `Scrolled ${direction}.`;
}

function formatPosts(posts: VisiblePost[], title: string): string {
  if (!posts.length)
    return "No posts are visible on screen right now. Try scrolling down, or going to the home feed first.";
  return (
    `${title} (reference posts by their number):\n` +
    posts
      .map(
        (p) =>
          `#${p.index} — ${p.author}${p.reactionState !== "no reaction" ? ` [you reacted: ${p.reactionState}]` : ""}\n` +
          `   "${p.text || "(no text — image or video post)"}"\n` +
          `   ${p.reactions || "0"} reactions · ${p.comments || "0"} comments`
      )
      .join("\n")
  );
}

/**
 * Wait for feed content to actually exist rather than sleeping a fixed amount.
 * Faster than a long pause on a quick load, and reliable on a slow one.
 */
async function waitForPosts(page: Page, timeout = 6000): Promise<void> {
  await page
    .locator(MENU_BTN)
    .first()
    .waitFor({ state: "attached", timeout })
    .catch(() => {});
}

async function readVisiblePostsInternal(page: Page): Promise<VisiblePost[]> {
  await waitForPosts(page);
  const raw = await page.evaluate((menuSel) => {
    const out: {
      id: string;
      author: string;
      text: string;
      reactionState: string;
      reactions: string;
      comments: string;
      top: number;
    }[] = [];
    const seen = new Set<Element>();
    const menuBtns = Array.from(document.querySelectorAll(`main ${menuSel}`));
    for (const b of menuBtns) {
      let root: HTMLElement | null = b.parentElement;
      while (root && !root.querySelector('button[aria-label="Comment"]')) root = root.parentElement;
      if (!root || seen.has(root)) continue;
      seen.add(root);

      const rect = root.getBoundingClientRect();
      if (rect.bottom < -100 || rect.top > window.innerHeight * 1.5) {
        root.removeAttribute("data-jarvis-post");
        continue;
      }
      let id = root.getAttribute("data-jarvis-post");
      if (!id) {
        id = "jp" + Math.random().toString(36).slice(2, 10);
        root.setAttribute("data-jarvis-post", id);
      }
      const author = (b.getAttribute("aria-label") || "").replace(
        "Open control menu for post by ",
        ""
      );
      const tb = root.querySelector('[data-testid="expandable-text-box"]') as HTMLElement | null;
      let text = (tb?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400);
      if (!text) {
        // activity/profile pages render post bodies without the testid — fall
        // back to the post's own text minus chrome (author, buttons, counts)
        const chrome = new Set([
          "Like", "Comment", "Repost", "Send", "Follow", "Following", "See more", "…more",
        ]);
        text = ((root as HTMLElement).innerText || "")
          .split("\n")
          .map((l) => l.trim())
          .filter(
            (l) =>
              l.length > 25 &&
              !chrome.has(l) &&
              !l.startsWith(author) &&
              !/^\d+[hdwmo]$/.test(l) &&
              !/reaction|comment/i.test(l)
          )
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 400);
      }
      const react = root.querySelector('button[aria-label^="Reaction button state"]');
      const reactionState = (react?.getAttribute("aria-label") || "")
        .replace("Reaction button state: ", "")
        .trim();
      const bodyText = root.innerText || "";
      const reactions = (bodyText.match(/([\d,.]+[KM]?)\s*reaction/i)?.[1] ?? "").trim();
      const comments = (bodyText.match(/([\d,.]+[KM]?)\s*comments?/i)?.[1] ?? "").trim();
      out.push({ id, author, text, reactionState, reactions, comments, top: rect.top });
    }
    out.sort((a, b) => a.top - b.top);
    return out;
  }, MENU_BTN);

  return raw.map((p, i) => ({ ...p, index: i + 1 }));
}

export async function readVisiblePosts(): Promise<string> {
  const page = await getPage();
  const posts = await readVisiblePostsInternal(page);
  setLastPosts(posts.map((p) => ({ urn: p.id, author: p.author, text: p.text })));
  return formatPosts(posts, "Posts on screen");
}

/* ------------------------------------------------------------------ */
/* Locating a previously-read post                                     */
/* ------------------------------------------------------------------ */

async function locatePost(page: Page, target: number | string) {
  let posts = getLastPosts();
  if (!posts.length) {
    // be forgiving: read the screen automatically instead of failing
    const fresh = await readVisiblePostsInternal(page);
    setLastPosts(fresh.map((p) => ({ urn: p.id, author: p.author, text: p.text })));
    posts = getLastPosts();
    if (!posts.length) throw new Error("No posts on screen. Go to the feed and scroll a bit first.");
  }
  let entry;
  if (typeof target === "number") {
    entry = posts[target - 1];
    if (!entry) throw new Error(`There is no post #${target}. I currently see ${posts.length} posts.`);
  } else {
    const t = target.toLowerCase();
    entry = posts.find((p) => p.author.toLowerCase().includes(t));
    if (!entry) throw new Error(`No visible post by "${target}". Read the posts again.`);
  }
  const el = page.locator(`[data-jarvis-post="${entry.urn}"]`).first();
  if ((await el.count()) === 0) {
    throw new Error("That post left the screen. Read the visible posts again.");
  }
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await humanPause(page, 300, 550);
  return { el, entry };
}

/* ------------------------------------------------------------------ */
/* Reactions                                                           */
/* ------------------------------------------------------------------ */

export async function likePost(target: number | string, reaction?: string): Promise<string> {
  const page = await getPage();
  const { el, entry } = await locatePost(page, target);
  const reactBtn = el.locator('button[aria-label^="Reaction button state"]').first();
  if ((await reactBtn.count()) === 0) throw new Error("Couldn't find the reaction button on that post.");

  const stateLabel = ((await reactBtn.getAttribute("aria-label")) || "").replace(
    "Reaction button state: ",
    ""
  );
  const hasReaction = stateLabel !== "no reaction";

  if (reaction && !/^like$/i.test(reaction)) {
    const trayBtn = el.locator('button[aria-label="Open reactions menu"]').first();
    if ((await trayBtn.count()) > 0) {
      await jsClick(trayBtn);
      // the tray animates in — wait for an option to actually exist
      await page
        .locator('button:has-text("Celebrate"), button:has-text("Insightful")')
        .first()
        .waitFor({ state: "visible", timeout: 4000 })
        .catch(() => {});
      // tray options are plain buttons labelled "Celebrate", "Love", "Insightful"…
      const picked = await pickByText(page, new RegExp(`^${reaction}$`, "i"));
      if (picked) {
        await humanPause(page);
        return `Reacted "${picked}" to ${entry.author}'s post.`;
      }
      await dismissOverlays(page); // tray missed — fall through to a plain like
    }
  }

  if (hasReaction) return `You already reacted "${stateLabel}" to ${entry.author}'s post.`;
  await jsClick(reactBtn);
  await humanPause(page);
  return `Liked ${entry.author}'s post.`;
}

export async function unlikePost(target: number | string): Promise<string> {
  const page = await getPage();
  const { el, entry } = await locatePost(page, target);
  const reactBtn = el.locator('button[aria-label^="Reaction button state"]').first();
  if ((await reactBtn.count()) === 0) throw new Error("Couldn't find the reaction button on that post.");
  const stateLabel = ((await reactBtn.getAttribute("aria-label")) || "").replace(
    "Reaction button state: ",
    ""
  );
  if (stateLabel === "no reaction") return `You haven't reacted to ${entry.author}'s post.`;
  await jsClick(reactBtn); // toggles the reaction off
  await humanPause(page);
  return `Removed your "${stateLabel}" reaction from ${entry.author}'s post.`;
}

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

const COMMENT_EDITOR = '[aria-label="Text editor for creating comment"]';

export async function commentOnPost(target: number | string, text: string): Promise<string> {
  const page = await getPage();
  const { el, entry } = await locatePost(page, target);

  const commentBtn = el.locator('button[aria-label="Comment"]').first();
  if ((await commentBtn.count()) === 0) throw new Error("Couldn't find the Comment button.");
  await jsClick(commentBtn);
  await page.waitForTimeout(700);

  // The editor mounts outside the post root — pick the editor closest to it,
  // stamp it, and drive it through Playwright for trusted input events.
  const editorId = await page.evaluate(
    ({ postId, editorSel }) => {
      const post = document.querySelector(`[data-jarvis-post="${postId}"]`);
      const postRect = post?.getBoundingClientRect();
      const editors = Array.from(document.querySelectorAll(editorSel));
      if (!editors.length) return null;
      let best: Element = editors[0];
      let bestDist = Infinity;
      for (const e of editors) {
        const r = e.getBoundingClientRect();
        const dist = postRect ? Math.abs(r.top - postRect.bottom) : r.top;
        if (dist < bestDist) {
          bestDist = dist;
          best = e;
        }
      }
      const id = "je" + Math.random().toString(36).slice(2, 10);
      best.setAttribute("data-jarvis-editor", id);
      return id;
    },
    { postId: entry.urn, editorSel: COMMENT_EDITOR }
  );
  if (!editorId) throw new Error("The comment box didn't open.");

  const editor = page.locator(`[data-jarvis-editor="${editorId}"]`);
  await focusEditor(editor);
  await editor.pressSequentially(text, { delay: 12 + Math.random() * 18 });
  await humanPause(page, 350, 650);

  // The submit button (labelled "Comment") appears near the editor once text exists
  const clicked = await page.evaluate((eid) => {
    const editor = document.querySelector(`[data-jarvis-editor="${eid}"]`);
    let c: HTMLElement | null = editor as HTMLElement;
    for (let i = 0; i < 10 && c; i++) {
      const btns = Array.from(c.querySelectorAll("button")).filter(
        (b) => (b.textContent || "").trim() === "Comment" && !b.getAttribute("aria-label")?.includes("Comment on")
      );
      const submit = btns[btns.length - 1];
      if (submit) {
        submit.setAttribute("data-jarvis-submit", "1");
        return true;
      }
      c = c.parentElement;
    }
    return false;
  }, editorId);
  if (!clicked) throw new Error("Typed the comment but couldn't find the submit button.");
  await jsClick(page.locator('[data-jarvis-submit="1"]'));
  await page.evaluate(() =>
    document.querySelector('[data-jarvis-submit="1"]')?.removeAttribute("data-jarvis-submit")
  );
  await humanPause(page, 250, 450);
  return `Commented on ${entry.author}'s post: "${text}"`;
}

export async function openPostComments(target: number | string): Promise<string> {
  const page = await getPage();
  const { el, entry } = await locatePost(page, target);
  const commentBtn = el.locator('button[aria-label="Comment"]').first();
  if ((await commentBtn.count()) > 0) {
    await jsClick(commentBtn);
    await page.waitForTimeout(900);
  }
  const comments = await page.evaluate((postId) => {
    const post = document.querySelector(`[data-jarvis-post="${postId}"]`);
    const container = post?.parentElement?.parentElement ?? document;
    const arts = Array.from(container.querySelectorAll("article"));
    return arts
      .map((n) => ((n as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 250))
      .filter((t) => t.length > 10)
      .slice(0, 6);
  }, entry.urn);
  if (!comments.length) return `Opened comments on ${entry.author}'s post — none readable yet.`;
  return `Comments on ${entry.author}'s post:\n` + comments.map((c, i) => `${i + 1}. ${c}`).join("\n");
}

export async function expandPost(target: number | string): Promise<string> {
  const page = await getPage();
  const { el, entry } = await locatePost(page, target);
  const more = el.locator('[data-testid="expandable-text-button"]').first();
  if ((await more.count()) === 0) return `${entry.author}'s post is already fully visible: "${entry.text}"`;
  // the "see more" button is aria-hidden and overlaid — a JS click avoids hit-testing
  await more.evaluate((n) => (n as HTMLElement).click());
  await page.waitForTimeout(800);
  const full = await el
    .locator('[data-testid="expandable-text-box"]')
    .first()
    .innerText()
    .catch(() => entry.text);
  return `Full post by ${entry.author}: "${full.replace(/\s+/g, " ").trim().slice(0, 1500)}"`;
}

/* ------------------------------------------------------------------ */
/* Post control menu actions (save, copy link, delete own post)        */
/* ------------------------------------------------------------------ */

async function clickPostMenuItem(page: Page, postId: string, itemPattern: RegExp): Promise<string | null> {
  const el = page.locator(`[data-jarvis-post="${postId}"]`).first();
  const menuBtn = el.locator(MENU_BTN).first();
  if ((await menuBtn.count()) === 0) throw new Error("Couldn't open the post's menu.");
  await jsClick(menuBtn);
  await page.waitForTimeout(600);

  const found = await page.evaluate((patSrc) => {
    const pat = new RegExp(patSrc, "i");
    const candidates = Array.from(
      document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="button"]')
    );
    for (const c of candidates) {
      const t = (c.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length < 60 && pat.test(t)) {
        c.setAttribute("data-jarvis-menu-item", "1");
        return t;
      }
    }
    return null;
  }, itemPattern.source);

  if (!found) {
    await dismissOverlays(page);
    return null;
  }
  await page.click('[data-jarvis-menu-item="1"]');
  await page.evaluate(() =>
    document.querySelector('[data-jarvis-menu-item="1"]')?.removeAttribute("data-jarvis-menu-item")
  );
  await humanPause(page, 350, 650);
  return found;
}

export async function savePost(target: number | string): Promise<string> {
  const page = await getPage();
  const { entry } = await locatePost(page, target);
  const clicked = await clickPostMenuItem(page, entry.urn, /^save$/);
  if (!clicked) return `Couldn't find "Save" in the menu of ${entry.author}'s post — it may already be saved.`;
  return `Saved ${entry.author}'s post for later.`;
}

export async function deletePost(target: number | string): Promise<string> {
  const page = await getPage();
  const { entry } = await locatePost(page, target);
  const clicked = await clickPostMenuItem(page, entry.urn, /delete/);
  if (!clicked) {
    return `No "Delete" option on ${entry.author}'s post — you can only delete your own posts.`;
  }
  await page.waitForTimeout(1000);
  // confirmation dialog
  const confirm = page
    .locator('[role="dialog"] button:has-text("Delete"), [role="alertdialog"] button:has-text("Delete")')
    .last();
  if ((await confirm.count()) > 0) {
    await jsClick(confirm);
    await humanPause(page, 250, 450);
  }
  return `Deleted the post by ${entry.author}.`;
}

// Resolved once per server session; "/in/me/" no longer redirects reliably in
// the new UI, so we read the user's real profile URL from the feed sidebar.
let ownProfileUrl: string | null = null;

async function getOwnProfileUrl(page: Page): Promise<string> {
  if (ownProfileUrl) return ownProfileUrl;
  if (!page.url().includes("/feed")) {
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
    await humanPause(page, 400, 700);
  }
  const href = await page
    .evaluate(() => document.querySelector('a[href*="/in/"]')?.getAttribute("href") ?? null)
    .catch(() => null);
  if (!href) throw new Error("Couldn't find your profile link on the feed page.");
  ownProfileUrl = new URL(href, "https://www.linkedin.com").toString().split("?")[0];
  return ownProfileUrl;
}

let ownName: string | null = null;

/**
 * The user's display name. The new profile page has no <h1>, so we read the
 * identity card in the feed's left rail — its first line is the member's name.
 */
async function getOwnName(page: Page): Promise<string> {
  if (ownName) return ownName;
  if (!page.url().includes("/feed")) {
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
    await humanPause(page, 600, 1000);
  }
  ownName = await page.evaluate(() => {
    const link = document.querySelector('a[href*="/in/"]');
    let card: HTMLElement | null = link as HTMLElement;
    for (let i = 0; i < 5 && card; i++) {
      const first = (card.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean)[0];
      if (first && first.length > 1 && first.length < 60) return first;
      card = card.parentElement;
    }
    return "";
  });
  if (!ownName) throw new Error("Couldn't work out your LinkedIn display name.");
  return ownName;
}

/** The user's own activity: their posts, their comments, or their reactions. */
export async function openMyActivity(
  kind: "posts" | "comments" | "reactions" = "posts"
): Promise<string> {
  const page = await getPage();
  const profile = await getOwnProfileUrl(page);
  const path = { posts: "all", comments: "comments", reactions: "reactions" }[kind];
  await page.goto(`${profile.replace(/\/$/, "")}/recent-activity/${path}/`, {
    waitUntil: "domcontentloaded",
  });
  await humanPause(page, 900, 1400);

  if (kind === "posts") {
    const posts = await readVisiblePostsInternal(page);
    setLastPosts(posts.map((p) => ({ urn: p.id, author: p.author, text: p.text })));
    return formatPosts(posts, "Your recent posts");
  }

  // comments/reactions render as feed posts — wait for them rather than guessing
  await waitForPosts(page);
  const items = await page.evaluate(() => {
    const main = (document.querySelector("main") as HTMLElement | null)?.innerText ?? "";
    return main
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 20)
      .slice(0, 8);
  });
  if (!items.length) return `You have no recent ${kind}.`;

  // let the agent act on these posts too ("delete my comment on that one")
  const posts = await readVisiblePostsInternal(page);
  setLastPosts(posts.map((p) => ({ urn: p.id, author: p.author, text: p.text })));
  return `Your recent ${kind}:\n` + items.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

export async function openSavedPosts(): Promise<string> {
  const page = await getPage();
  await page.goto("https://www.linkedin.com/my-items/saved-posts/", {
    waitUntil: "domcontentloaded",
  });
  await humanPause(page, 900, 1400);
  const posts = await readVisiblePostsInternal(page);
  if (posts.length) {
    setLastPosts(posts.map((p) => ({ urn: p.id, author: p.author, text: p.text })));
    return formatPosts(posts, "Your saved posts");
  }
  const text = await page.evaluate(
    () => (document.querySelector("main") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").slice(0, 500) ?? ""
  );
  return `Saved items page: ${text || "nothing saved yet."}`;
}

export async function openMyRecentPosts(): Promise<string> {
  const page = await getPage();
  const profile = await getOwnProfileUrl(page);
  await page.goto(`${profile.replace(/\/$/, "")}/recent-activity/all/`, {
    waitUntil: "domcontentloaded",
  });
  await humanPause(page, 900, 1400);
  const posts = await readVisiblePostsInternal(page);
  setLastPosts(posts.map((p) => ({ urn: p.id, author: p.author, text: p.text })));
  return formatPosts(posts, "Your recent posts and activity");
}

/* ------------------------------------------------------------------ */
/* Repost                                                              */
/* ------------------------------------------------------------------ */

export async function repost(target: number | string, thoughts?: string): Promise<string> {
  const page = await getPage();
  const { el, entry } = await locatePost(page, target);
  const repostBtn = el.locator('button[aria-label="Repost"], button:has-text("Repost")').first();
  if ((await repostBtn.count()) === 0) throw new Error("Couldn't find the Repost button.");
  await jsClick(repostBtn);
  await page.waitForTimeout(700);

  if (thoughts) {
    const withThoughts = page
      .locator('[role="menuitem"]:has-text("thoughts"), button:has-text("your thoughts")')
      .first();
    if ((await withThoughts.count()) > 0) {
      await jsClick(withThoughts);
      await page.waitForTimeout(1800);
      const editor = page.locator('[role="dialog"] [contenteditable="true"]').first();
      if ((await editor.count()) > 0) {
        await focusEditor(editor);
        await editor.pressSequentially(thoughts, { delay: 12 + Math.random() * 18 });
        await humanPause(page, 400, 700);
        const postBtn = page.locator('[role="dialog"] button:has-text("Post")').last();
        await jsClick(postBtn);
        await humanPause(page, 300, 550);
        return `Reposted ${entry.author}'s post with your thoughts: "${thoughts}"`;
      }
    }
  }
  const instant = page
    .locator('[role="menuitem"]:has-text("Repost"), [role="menu"] button:has-text("Repost")')
    .last();
  if ((await instant.count()) > 0) {
    await jsClick(instant);
    await humanPause(page, 250, 450);
    return `Reposted ${entry.author}'s post to your followers.`;
  }
  await dismissOverlays(page);
  throw new Error("The repost menu opened but I couldn't pick an option.");
}

/* ------------------------------------------------------------------ */
/* Creating a post                                                     */
/* ------------------------------------------------------------------ */

export async function createPost(text: string): Promise<string> {
  const page = await getPage();

  // The "Start a post" tile is an anchor to /preload/sharebox/ whose click
  // handler React sometimes swallows — navigating straight there is reliable.
  await page.goto("https://www.linkedin.com/preload/sharebox/", { waitUntil: "domcontentloaded" });
  await humanPause(page, 900, 1400);

  const editor = page
    .locator('[aria-label="Text editor for creating content"], [role="dialog"] [contenteditable="true"]')
    .first();
  if ((await editor.count()) === 0) throw new Error("The post composer didn't open.");
  await focusEditor(editor);
  await editor.pressSequentially(text, { delay: 12 + Math.random() * 18 });
  await humanPause(page, 250, 450);

  // The Post button stays disabled until the editor has content
  const postBtn = page.locator('button:has-text("Post"):not([disabled])').last();
  await postBtn.waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
  if ((await postBtn.count()) === 0) {
    throw new Error("Typed the post but the Post button never enabled.");
  }
  await jsClick(postBtn);
  await humanPause(page, 1200, 1800);
  await goHome();
  return `Published your post: "${text.slice(0, 120)}${text.length > 120 ? "…" : ""}"`;
}

/* ------------------------------------------------------------------ */
/* Following & connecting                                              */
/* ------------------------------------------------------------------ */

export async function followPerson(name: string): Promise<string> {
  const page = await getPage();
  // A visible "Follow {name}" button in the feed?
  const feedFollow = page.locator(`main button[aria-label="Follow ${name}"]`).first();
  if ((await feedFollow.count()) > 0) {
    await jsClick(feedFollow);
    await humanPause(page);
    return `Now following ${name}.`;
  }
  // Otherwise via their profile
  await openProfile(name);
  const btn = page
    .locator('main button:has-text("Follow"), main button[aria-label*="Follow" i]')
    .first();
  if ((await btn.count()) === 0) {
    return `Opened ${name}'s profile but there's no Follow button — you may already follow them.`;
  }
  await jsClick(btn);
  await humanPause(page);
  return `Now following ${name}.`;
}

export async function unfollowPerson(name: string): Promise<string> {
  const page = await getPage();
  await openProfile(name);
  const btn = page.locator('main button[aria-label*="click to unfollow" i], main button:has-text("Following")').first();
  if ((await btn.count()) === 0) return `You're not following ${name}.`;
  await jsClick(btn);
  await humanPause(page, 700, 1100);
  // a confirmation sheet sometimes appears
  await pickByText(page, /^unfollow$/i);
  await humanPause(page, 600, 1000);
  return `Unfollowed ${name}.`;
}

export async function connectWithPerson(name: string, note?: string): Promise<string> {
  const page = await getPage();
  await openProfile(name);
  let connectBtn = page
    .locator('main button:has-text("Connect"), main button[aria-label*="to connect" i]')
    .first();
  if ((await connectBtn.count()) === 0) {
    // sometimes hidden under "More"
    const more = page.locator('main button:has-text("More")').first();
    if ((await more.count()) > 0) {
      await jsClick(more);
      await page.waitForTimeout(1000);
      connectBtn = page
        .locator('[role="menuitem"]:has-text("Connect"), [role="menu"] button:has-text("Connect")')
        .first();
    }
  }
  if ((await connectBtn.count()) === 0) {
    await dismissOverlays(page);
    return `Couldn't find a Connect option for ${name} — you may already be connected.`;
  }
  await jsClick(connectBtn);
  await page.waitForTimeout(700);

  if (note) {
    const addNote = page.locator('button:has-text("Add a note")').first();
    if ((await addNote.count()) > 0) {
      await jsClick(addNote);
      await page.waitForTimeout(800);
      const ta = page.locator('[role="dialog"] textarea').first();
      if ((await ta.count()) > 0) await ta.fill(note);
    }
  }
  const send = page
    .locator(
      '[role="dialog"] button:has-text("Send without a note"), [role="dialog"] button:has-text("Send invitation"), [role="dialog"] button:has-text("Send")'
    )
    .last();
  if ((await send.count()) === 0) {
    await dismissOverlays(page);
    throw new Error("The connect dialog opened but I couldn't find Send.");
  }
  await jsClick(send);
  await humanPause(page);
  return `Sent a connection request to ${name}${note ? " with your note" : ""}.`;
}

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

export async function readMessages(): Promise<string> {
  const page = await getPage();
  await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded" });
  await humanPause(page, 900, 1400);
  const convos = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll(
        "li.msg-conversation-listitem, main [role='listitem'], main li"
      )
    )
      .map((n) => ((n as HTMLElement).innerText || "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 15 && t.length < 300);
    return Array.from(new Set(rows)).slice(0, 8);
  });
  if (!convos.length) return "Messaging is open but the conversation list looks empty.";
  return "Recent conversations:\n" + convos.map((c, i) => `${i + 1}. ${c}`).join("\n");
}

async function gotoMessaging(page: Page) {
  if (!page.url().includes("/messaging")) {
    await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded" });
    await humanPause(page, 900, 1400);
  }
}

/** Open an existing thread with `personName`. Returns false if there isn't one. */
async function openThread(page: Page, personName: string): Promise<boolean> {
  await gotoMessaging(page);
  const convo = page
    .locator(
      `li.msg-conversation-listitem:has-text("${personName}"), main [role="listitem"]:has-text("${personName}"), main li:has-text("${personName}")`
    )
    .first();
  if ((await convo.count()) === 0) return false;
  await jsClick(convo);
  await humanPause(page, 700, 1100);
  return true;
}

function messageBox(page: Page) {
  return page
    .locator(
      'div.msg-form__contenteditable, main [contenteditable="true"][role="textbox"], main [aria-label*="Write a message" i], main [aria-label*="message" i][contenteditable="true"]'
    )
    .first();
}

async function clickSend(page: Page) {
  const send = page
    .locator('button.msg-form__send-button, main button[aria-label*="Send" i]:not([disabled]), main button:has-text("Send")')
    .first();
  if ((await send.count()) === 0) {
    // some composers submit on Enter only
    await page.keyboard.press("Enter");
    return;
  }
  await jsClick(send);
}

/**
 * DM someone. Uses the existing thread if there is one; otherwise opens the
 * compose flow and picks the recipient from the suggestions.
 */
export async function sendMessage(personName: string, text: string): Promise<string> {
  const page = await getPage();
  const existing = await openThread(page, personName);

  if (!existing) {
    await gotoMessaging(page);
    const compose = page
      .locator('button[aria-label*="Compose a new message" i], a[aria-label*="Compose" i]')
      .first();
    if ((await compose.count()) === 0) {
      throw new Error(`No conversation with "${personName}", and I can't find the compose button.`);
    }
    await jsClick(compose);
    await humanPause(page, 700, 1100);

    const to = page
      .locator('input[aria-label*="recipient" i], input[placeholder*="Type a name" i], main input[role="combobox"]')
      .first();
    if ((await to.count()) === 0) throw new Error("The new-message composer didn't open.");
    await to.click();
    await to.pressSequentially(personName, { delay: 40 });
    await humanPause(page, 1200, 1800);

    // pick the first matching suggestion
    const picked = await pickByText(page, new RegExp(personName.split(/\s+/)[0], "i"));
    if (!picked) throw new Error(`Couldn't find "${personName}" in the recipient suggestions.`);
    await humanPause(page, 600, 1000);
  }

  const box = messageBox(page);
  if ((await box.count()) === 0) throw new Error("Couldn't find the message box.");
  await focusEditor(box);
  await box.pressSequentially(text, { delay: 12 + Math.random() * 18 });
  await humanPause(page, 300, 550);
  await clickSend(page);
  await humanPause(page, 600, 1000);
  return `Sent to ${personName}: "${text}"`;
}

/** Open the "..." menu on the user's most recent message in a thread. */
async function openOwnMessageMenu(page: Page, personName: string): Promise<void> {
  const opened = await openThread(page, personName);
  if (!opened) throw new Error(`You have no conversation with "${personName}".`);

  // Each message row exposes its own options button; the last one is the newest.
  const options = page.locator(
    'button[aria-label*="options" i], button[aria-label*="More actions" i], button[aria-label*="Open menu" i]'
  );
  const count = await options.count();
  if (count === 0) throw new Error("I can't find the options button on your message.");

  const last = options.nth(count - 1);
  await last.scrollIntoViewIfNeeded().catch(() => {});
  await last.hover().catch(() => {}); // LinkedIn only reveals it on hover
  await humanPause(page, 300, 550);
  await jsClick(last);
  await humanPause(page, 500, 900);
}

export async function editMessage(personName: string, newText: string): Promise<string> {
  const page = await getPage();
  await openOwnMessageMenu(page, personName);

  const picked = await pickByText(page, /^edit/i);
  if (!picked) {
    await dismissOverlays(page);
    throw new Error("No Edit option there — you can only edit your own messages.");
  }
  await humanPause(page, 600, 1000);

  const box = messageBox(page);
  if ((await box.count()) === 0) throw new Error("The edit box didn't open.");
  await focusEditor(box);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await box.pressSequentially(newText, { delay: 12 + Math.random() * 18 });
  await humanPause(page, 300, 550);

  const saved = await pickByText(page, /^(save|done)$/i);
  if (!saved) await clickSend(page);
  await humanPause(page, 600, 1000);
  return `Edited your last message to ${personName}: "${newText}"`;
}

export async function deleteMessage(personName: string): Promise<string> {
  const page = await getPage();
  await openOwnMessageMenu(page, personName);

  const picked = await pickByText(page, /^delete/i);
  if (!picked) {
    await dismissOverlays(page);
    throw new Error("No Delete option there — you can only delete your own messages.");
  }
  await humanPause(page, 500, 900);
  await pickByText(page, /^delete$/i); // confirmation modal
  await humanPause(page, 600, 1000);
  return `Deleted your last message to ${personName}.`;
}

/* ------------------------------------------------------------------ */
/* Screen description                                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Generic interaction — "click on that", "open the photo", "go back"  */
/* ------------------------------------------------------------------ */

/**
 * Click anything on screen by its visible text or accessible label. This is
 * the escape hatch that keeps the whole of LinkedIn reachable even where
 * there's no dedicated tool ("click Jobs", "hit See all", "press Skip").
 */
export async function clickElement(label: string): Promise<string> {
  const page = await getPage();
  const target = label.trim();

  const found = await page.evaluate((want) => {
    const wl = want.toLowerCase();
    const nodes = Array.from(
      document.querySelectorAll(
        'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="link"], input[type="submit"]'
      )
    ) as HTMLElement[];

    const score = (el: HTMLElement): number => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return -1; // invisible
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const onScreen = r.top >= -50 && r.top < window.innerHeight;
      let s = -1;
      if (aria === wl || text === wl) s = 100;
      else if (aria.startsWith(wl) || text.startsWith(wl)) s = 80;
      else if (aria.includes(wl) || text.includes(wl)) s = 60;
      if (s > 0 && onScreen) s += 15; // prefer what the user can actually see
      return s;
    };

    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const el of nodes) {
      const s = score(el);
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    }
    if (!best) return null;
    best.setAttribute("data-jarvis-click", "1");
    return (best.getAttribute("aria-label") || best.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60);
  }, target);

  if (!found) throw new Error(`I can't find anything labelled "${target}" on screen.`);
  await jsClick(page.locator('[data-jarvis-click="1"]'));
  await page
    .evaluate(() => document.querySelector('[data-jarvis-click="1"]')?.removeAttribute("data-jarvis-click"))
    .catch(() => {});
  await humanPause(page, 500, 900);
  return `Clicked "${found}".`;
}

export async function goBack(): Promise<string> {
  const page = await getPage();
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  await humanPause(page, 400, 700);
  const title = await page.title().catch(() => "");
  return `Went back to ${title}.`;
}

/** Open the profile photo of whoever's profile is currently on screen. */
export async function viewProfilePhoto(name?: string): Promise<string> {
  const page = await getPage();
  if (name) await openProfile(name);

  const btn = page
    .locator('main button:has(img), main [aria-label*="photo" i], main img[alt*="profile" i]')
    .first();
  if ((await btn.count()) === 0) throw new Error("I can't find a profile photo on this page.");
  await jsClick(btn);
  await humanPause(page, 700, 1100);

  const opened = await page
    .locator('[role="dialog"] img, [role="dialog"]')
    .first()
    .count()
    .catch(() => 0);
  const who = await page.locator("main h1").first().textContent().catch(() => null);
  return opened
    ? `Opened ${who?.trim() ?? "the"} profile photo — it's on screen now.`
    : `Clicked the profile photo of ${who?.trim() ?? "this person"}.`;
}

/** Delete one of the user's own comments on a post (the "undo a comment" case). */
export async function deleteComment(target: number | string): Promise<string> {
  const page = await getPage();
  const { entry } = await locatePost(page, target);
  await openPostComments(target);

  // LinkedIn labels each comment's menu with its author: "View more options for
  // {name}'s comment." Match the user's own name so we never touch someone else's.
  const me = await getOwnName(page);
  const mine = page.locator(`button[aria-label*="View more options for ${me}" i]`).first();
  const anyComment = page.locator('button[aria-label*="options for" i][aria-label*="comment" i]').first();

  // comments stream in after the Comment button is clicked
  await anyComment.waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
  const menu = (await mine.count()) > 0 ? mine : anyComment;
  if ((await menu.count()) === 0) {
    throw new Error("I can't find your comment on that post — you may not have commented on it.");
  }
  await jsClick(menu);
  await humanPause(page, 500, 900);

  // The dropdown items are plain buttons (no menuitem role), so match by text.
  const picked = await pickByText(page, /^delete$/i);
  if (!picked) {
    await dismissOverlays(page);
    throw new Error("No Delete option there — you can only delete your own comments.");
  }
  await humanPause(page, 500, 900);

  // confirmation modal
  const confirmed = await pickByText(page, /^delete$/i);
  if (!confirmed) await dismissOverlays(page);
  await humanPause(page, 500, 900);
  return `Deleted your comment on ${entry.author}'s post.`;
}

/** Called before every tool so a CAPTCHA never looks like a silent failure. */
export async function guardSession(): Promise<void> {
  const page = await getPage();
  await assertNoCheckpoint(page);
}

export async function describeScreen(): Promise<string> {
  const page = await getPage();
  const url = page.url();
  const title = await page.title().catch(() => "");
  const posts = await readVisiblePostsInternal(page);
  if (posts.length) {
    setLastPosts(posts.map((p) => ({ urn: p.id, author: p.author, text: p.text })));
    return `Current page: ${title} (${url})\n` + formatPosts(posts, "Posts on screen");
  }
  const text = await page
    .evaluate(() => (document.querySelector("main") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").slice(0, 600) ?? "")
    .catch(() => "");
  return `Current page: ${title} (${url}). Content: ${text}`;
}
