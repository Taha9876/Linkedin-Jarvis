/**
 * A single cancel flag shared by the API routes and the browser tools.
 *
 * Long-running actions (a slow scroll, a multi-step read) poll `cancelled()`
 * between steps, so when the user says "stop" — or simply starts a new command —
 * the browser stops mid-action instead of finishing the whole thing first.
 */

const g = globalThis as unknown as { __jarvisCancel?: { token: number; cancelled: boolean } };

function state() {
  if (!g.__jarvisCancel) g.__jarvisCancel = { token: 0, cancelled: false };
  return g.__jarvisCancel;
}

/** Begin a new run. Any in-flight action sees `cancelled()` become true. */
export function beginRun(): number {
  const s = state();
  s.cancelled = false;
  return ++s.token;
}

/** Stop whatever is running right now. */
export function cancelRun(): void {
  state().cancelled = true;
}

export function cancelled(): boolean {
  return state().cancelled;
}

/** Sleep that wakes early if the run is cancelled. Returns false if cancelled. */
export async function interruptibleSleep(ms: number, step = 60): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cancelled()) return false;
    await new Promise((r) => setTimeout(r, Math.min(step, end - Date.now())));
  }
  return !cancelled();
}
