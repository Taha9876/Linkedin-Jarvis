# Jarvis for LinkedIn 🎙️

A voice-controlled assistant that operates your real LinkedIn account through a Chrome
window it drives with Playwright. Talk to it — it scrolls, reads posts aloud, likes,
comments, posts, searches, checks notifications and messages, and talks back.

## Run it

```bash
npm run dev
```

Open http://localhost:3000 in **Chrome or Edge** (voice input needs the Web Speech API).

## Deploy to Vercel ☁️ (no browser service needed)

Chromium is bundled **into the serverless function** via `@sparticuz/chromium`. No Browserbase, no
VPS, no API key for the browser.

The hard part isn't running Chromium — it's that a Vercel function is **stateless**: the browser is
born and dies inside one request. So everything a long-lived browser normally holds is carried
between requests in httpOnly cookies on your own domain:

| what | where it lives |
|---|---|
| LinkedIn auth (`li_at`) | httpOnly cookie |
| the page you were on | httpOnly cookie |
| your scroll position | httpOnly cookie |
| which posts are "#1, #2…" | httpOnly cookie |

Each request: launch Chromium → restore cookies → return to your page and scroll offset → do the
thing → save the new state → close.

### Steps

1. Push to GitHub, import on Vercel.
2. Set env vars: `GROQ_API_KEY` (and optionally `GEMINI_API_KEY`).
3. Open the deployed URL → **"Sign in with your li_at cookie"**.

### Why the cookie, not a password?

A serverless browser has **no window**, so if LinkedIn throws a CAPTCHA at login there is nowhere for
you to solve it — and it will, because Vercel runs on datacenter IPs. Pasting an existing session
cookie skips the login form entirely:

> DevTools → Application → Cookies → `linkedin.com` → copy the value of **`li_at`**

Your password never leaves your machine. (You can also set it as the `LINKEDIN_LI_AT` env var.)

### Honest limits of this mode

- **Slower.** Every command pays a Chromium cold start (~1-3s) on top of the action.
- **No live tool progress.** Cookies can't be written once a response has started streaming, so the
  turn is buffered and sent in one go.
- **LinkedIn is harsher on datacenter IPs.** Expect more frequent security checks than at home. If
  one appears, you'll need to clear it in a normal browser.
- `li_at` expires (weeks, or on password change) — paste a fresh one when it does.

Local mode remains the fastest, least-flagged way to run this.

---

## Alternative: cloud browser with a live view (Browserbase)

If you want to *see* and interact with the cloud browser — solve CAPTCHAs in-page, watch Jarvis work
— set `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`. Vercel then reconnects over CDP to a
persistent Chrome instead of bundling one, and an interactive live view is embedded in the dashboard.

The three modes, chosen automatically by which env vars are set:

| | Local (default) | Vercel, bundled Chromium | Vercel + Browserbase |
|---|---|---|---|
| Trigger | no cloud vars | deployed, no BB key | `BROWSERBASE_API_KEY` |
| Browser | visible Chrome, your PC | headless, inside the function | persistent cloud Chrome |
| Login | email + password | paste `li_at` cookie | password or cookie |
| CAPTCHA | solve in the window | can't — use a fresh cookie | solve in **live view** |
| Speed | fastest | +1-3s cold start / command | fast |
| Your PC | must be on | can be off | can be off |

## First-time setup

1. Enter your LinkedIn email + password → **Connect & launch**. A real Chrome window opens and signs in.
2. If LinkedIn asks for a verification code, complete it in that Chrome window — the app detects it automatically.
3. Your session is saved in `.linkedin-profile/` (local only). Next time, just hit Connect with empty fields.
4. Click the orb, allow microphone access, and talk.

## Things to say

- "Scroll down" / "keep scrolling"
- "Read the posts on screen"
- "Like the second post" / "react celebrate to the post by Sarah"
- "Comment something nice on the first post"
- "What's in my notifications?"
- "Search for AI engineers"
- "Open Satya Nadella's profile"
- "Post: excited to share that…"
- "Read my messages" / "reply to John saying I'll call him tomorrow"

## What it can do

Scroll · read posts aloud · **summarize a post** · expand "see more" · like / react
(Celebrate, Love, Insightful, Funny, Support) · unlike · comment · **undo a comment** ·
open comments · save · repost · **create a post** · **delete your own post** ·
search people/posts/companies/jobs · open & read profiles · **view a profile photo** ·
follow · connect (with note) · notifications · read & send messages · your activity
(posts / comments / reactions) · saved items · go back · and **click anything on screen
by name** ("click Jobs", "press See all") — so nothing on LinkedIn is out of reach.

It understands loose phrasing: "make a posty", "start post", "share an update" all reach
`create_post`; "like it", "thumbs up", "hit like" all reach `like_post`.

## Urdu 🇵🇰

Jarvis replies in whatever language you speak — English, Urdu, or Roman Urdu — and understands
Urdu commands ("aahista se neeche scroll karo", "like karo", "post banao", "rok do").

**Important:** browser speech recognition cannot auto-detect language, so use the
**English / اردو** toggle in the header to tell it which you'll speak.

## Scrolling

Say "scroll slowly" and the feed glides gently so you can read along. Say **"stop"** (or "ruko",
"bas") at any moment and it halts *mid-scroll* — the browser polls a cancel flag between steps
rather than finishing the whole scroll first.

## The orb & themes

The orb is a real sphere: three stacked layers rotate around its own axis at different speeds
(a conic-gradient core, a counter-rotating swirl for depth, and a fixed specular highlight so it
reads as lit from one side), while a `hue-rotate` filter cycles its colour continuously. It spins
lazily when idle, quickens and pulses while listening, whirls fast while thinking, and throbs while
speaking — so you can tell its state from across the room.

**🌙 Dark / ☀️ Light** toggle sits in the header. Your choice is saved, defaults to your OS
preference, and is applied before first paint so there's no flash of the wrong theme.
Motion respects `prefers-reduced-motion`.

## Voice behaviour

- **Interrupt any time.** Just start talking while Jarvis is speaking — her speech and the
  in-flight request are cancelled immediately and your new command takes over. There's also a
  Stop button.
- A warm **female neural voice** (Gemini TTS, "Aoede"), spoken sentence by sentence with
  natural gaps. Sentence 1 starts playing while sentence 2 is still generating, so replies
  begin almost instantly. Toggle to the instant system voice with the **Voice** button.
- An echo filter stops the mic mistaking Jarvis's own voice for a new command.

## Deleting is always two steps

Any delete (post or comment) is refused on the first attempt by design. Jarvis reads the exact
post back to you and asks; only an explicit "yes" carries out the deletion. This is enforced in
code, not just the prompt, so the model can't skip it.

## Configuration

`.env.local` holds the keys. The agent tries three models in order and fails over automatically
on quota exhaustion (429), overload (503), or a botched tool call:

1. `gemini-flash-lite-latest` — fastest, most generous free quota
2. `gemini-flash-latest`
3. Groq `openai/gpt-oss-120b` — handles this many tool definitions reliably (llama-3.3 does not)

### Voice quality vs. speed

Voice tries `gemini-2.5-flash-preview-tts` ("Aoede"), then Groq PlayAI, then the browser's own voice.

**If neural TTS is unavailable (quota gone / terms not accepted), Jarvis uses the instant browser
voice and never retries it.** This matters: previously every sentence paid a ~1-2s round trip to a
dead provider *before* falling back, which made speech start noticeably late. Now the app probes
once on page load and, if neural is down, speaks immediately with zero network delay.

**To get the natural female voice back**, do either:
- accept the **PlayAI TTS terms** at console.groq.com (free, and fast — ~300ms), or
- wait for the Gemini free-tier daily quota to reset, or use a Gemini key with quota.

Neither is required — Jarvis works fully on the browser voice, just less human-sounding.

## Notes & warnings

- **LinkedIn rate-limits bursts with a CAPTCHA.** Actions are paced (4s minimum between writes,
  randomized delays, bulk likes capped at 3). If a checkpoint appears, the app detects it, shows a
  banner, and the agent stops until you solve it in the Chrome window.
- LinkedIn's terms prohibit automation — personal use on your own account only.
- The new LinkedIn React UI is targeted via accessibility attributes (`aria-label`, `data-testid`),
  which are far more stable than CSS classes. If an action breaks, fix it in `src/lib/linkedin.ts`.
- Credentials go from your browser to your localhost server to LinkedIn — never stored.
- `POST /api/tool` (`{"name":"like_post","args":{"target":"1"}}`) runs any action without the LLM,
  which is handy for debugging.
