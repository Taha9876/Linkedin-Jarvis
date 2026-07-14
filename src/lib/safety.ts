/**
 * Account safety.
 *
 * LinkedIn doesn't ban you for using a browser — it bans you for behaving like a
 * script: acting faster than a human can read, acting in perfectly even rhythms,
 * and doing hundreds of writes a day. This module makes all three impossible.
 *
 * The limits below are deliberately conservative — well under LinkedIn's known
 * enforcement thresholds — because the downside is asymmetric: a slightly slower
 * assistant costs you seconds, a restricted account costs you your network.
 *
 * Reads (scrolling, summarising) are unrestricted. Only WRITES are budgeted,
 * because those are what LinkedIn counts.
 */

export type ActionKind =
  | "like"
  | "comment"
  | "connect"
  | "follow"
  | "message"
  | "post"
  | "repost";

interface Budget {
  perHour: number;
  perDay: number;
  /** Minimum gap between two actions of this kind, in ms (before jitter). */
  minGapMs: number;
  label: string;
}

/**
 * LinkedIn's own guidance and community-reported thresholds put daily connection
 * invites around 100 and flag "excessive" activity well below that for new or
 * low-activity accounts. We sit far under those numbers on purpose.
 */
const BUDGETS: Record<ActionKind, Budget> = {
  like: { perHour: 30, perDay: 120, minGapMs: 8_000, label: "likes" },
  comment: { perHour: 8, perDay: 30, minGapMs: 45_000, label: "comments" },
  connect: { perHour: 6, perDay: 20, minGapMs: 60_000, label: "connection requests" },
  follow: { perHour: 10, perDay: 40, minGapMs: 20_000, label: "follows" },
  message: { perHour: 8, perDay: 30, minGapMs: 45_000, label: "messages" },
  post: { perHour: 2, perDay: 5, minGapMs: 300_000, label: "posts" },
  repost: { perHour: 3, perDay: 10, minGapMs: 120_000, label: "reposts" },
};

/** Any write at all — a global ceiling so the kinds can't stack into a spike. */
const GLOBAL = { perHour: 45, perDay: 180, minGapMs: 5_000 };

/** After this many writes in a row, take a longer breather. Humans do. */
const BURST_LIMIT = 8;
const BURST_COOLDOWN_MS = 90_000;

interface Event {
  kind: ActionKind;
  at: number;
}

const g = globalThis as unknown as { __jarvisSafety?: { events: Event[]; burst: number; burstUntil: number } };

function store() {
  if (!g.__jarvisSafety) g.__jarvisSafety = { events: [], burst: 0, burstUntil: 0 };
  return g.__jarvisSafety;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

function prune() {
  const s = store();
  const cutoff = Date.now() - DAY;
  s.events = s.events.filter((e) => e.at > cutoff);
}

function countSince(kind: ActionKind | "*", ms: number): number {
  prune();
  const since = Date.now() - ms;
  return store().events.filter((e) => e.at > since && (kind === "*" || e.kind === kind)).length;
}

function lastAt(kind: ActionKind | "*"): number {
  prune();
  const evts = store().events.filter((e) => kind === "*" || e.kind === kind);
  return evts.length ? evts[evts.length - 1].at : 0;
}

/**
 * Humans don't act on a metronome. Add generous randomised jitter so the gaps
 * between actions never form a detectable pattern.
 */
function jitter(baseMs: number): number {
  const spread = baseMs * 0.6;
  return Math.round(baseMs + (Math.random() * 2 - 1) * spread);
}

export class SafetyError extends Error {}

/**
 * Called before every write. Either returns (after waiting out any pacing delay)
 * or throws a SafetyError explaining, in words the agent can speak aloud, why
 * the action was refused.
 */
export async function guardWrite(kind: ActionKind): Promise<void> {
  const b = BUDGETS[kind];
  const s = store();

  // hard budgets first — these refuse, they don't wait
  const dayCount = countSince(kind, DAY);
  if (dayCount >= b.perDay) {
    throw new SafetyError(
      `Daily safety limit reached: ${b.perDay} ${b.label}. I've stopped to protect your account from being flagged. It resets on a rolling 24-hour basis.`
    );
  }
  const hourCount = countSince(kind, HOUR);
  if (hourCount >= b.perHour) {
    throw new SafetyError(
      `Hourly safety limit reached: ${b.perHour} ${b.label}. Let's give it a rest for a bit — this is what keeps your account safe.`
    );
  }
  if (countSince("*", DAY) >= GLOBAL.perDay) {
    throw new SafetyError(
      `Daily activity limit reached (${GLOBAL.perDay} actions). Stopping here to keep your account out of trouble.`
    );
  }
  if (countSince("*", HOUR) >= GLOBAL.perHour) {
    throw new SafetyError(
      `That's ${GLOBAL.perHour} actions this hour — my safety ceiling. Let's pause a while.`
    );
  }

  // burst cooldown: a human doesn't fire eight actions back to back and continue
  const now = Date.now();
  if (s.burstUntil > now) {
    const secs = Math.ceil((s.burstUntil - now) / 1000);
    throw new SafetyError(
      `I'm on a short cool-down for another ${secs} seconds — I did a run of actions and I'm pacing myself so LinkedIn doesn't see a burst.`
    );
  }

  // pacing: wait out the gap rather than refusing
  const waits = [
    jitter(b.minGapMs) - (now - lastAt(kind)),
    jitter(GLOBAL.minGapMs) - (now - lastAt("*")),
  ];
  const wait = Math.max(0, ...waits);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Record a write that actually succeeded. */
export function recordWrite(kind: ActionKind): void {
  const s = store();
  s.events.push({ kind, at: Date.now() });

  s.burst += 1;
  if (s.burst >= BURST_LIMIT) {
    s.burst = 0;
    s.burstUntil = Date.now() + jitter(BURST_COOLDOWN_MS);
  }
}

/** Reads are free, but a long uninterrupted run still resets the burst counter. */
export function noteRead(): void {
  const s = store();
  if (s.burst > 0) s.burst -= 0.5; // reading between writes looks human
}

export interface Usage {
  kind: ActionKind;
  label: string;
  hour: number;
  perHour: number;
  day: number;
  perDay: number;
}

export function usage(): { actions: Usage[]; totalDay: number; globalDay: number; cooldownSec: number } {
  const s = store();
  return {
    actions: (Object.keys(BUDGETS) as ActionKind[]).map((k) => ({
      kind: k,
      label: BUDGETS[k].label,
      hour: countSince(k, HOUR),
      perHour: BUDGETS[k].perHour,
      day: countSince(k, DAY),
      perDay: BUDGETS[k].perDay,
    })),
    totalDay: countSince("*", DAY),
    globalDay: GLOBAL.perDay,
    cooldownSec: Math.max(0, Math.ceil((s.burstUntil - Date.now()) / 1000)),
  };
}
