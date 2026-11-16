// Entry point: the wire between this program and the trial env.
//
// The env owns the schedule; this file only keeps the entry reachable for as long as the
// env wants it. The whole lifecycle:
//
//   1. Read the env's origin from MAKEFUN_ENV_URL. If it is missing there is nobody to
//      register with, so exit 1 immediately.
//   2. Build the server from app.ts and listen on port 0, letting the kernel pick a free
//      port (8080 belongs to the env, never bind it directly).
//   3. POST that port to the env's /register. The env notes the caller's address plus the
//      port and treats the pair as this entry's base URL from then on.
//   4. Poll /done until the env answers {"done": true}, then close the server and exit 0.
//
// Both network steps retry with backoff: the env may still be starting when the entry
// first calls, and a slow or failed poll only means "not done yet". Nothing in here may
// exit early — the process leaves when the env says the trial is over, or not at all.

import { createApp } from './app.ts';

// Trailing slashes are stripped so paths below can be appended unconditionally.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Upper bound for a single register or done request before it counts as failed. */
const TIMEOUT_MS = 30_000;
/** Delay after the first failure; doubles per failure up to the cap. */
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Wait after `failures` consecutive failures: exponential growth, capped, exponent clamped. */
function backoffMs(failures: number): number {
  const grown = BACKOFF_START_MS * 2 ** Math.min(failures, 8);
  return Math.min(BACKOFF_CAP_MS, grown);
}

/**
 * Tell the env which port this process bound, retrying until it accepts.
 *
 * 200 means registered. 409 means an earlier register already won the slot — also fine,
 * and not something a retry could change. 400 and 405 are contract violations, so they
 * abort the process with the env's answer attached. Anything else (env still booting,
 * a transient status, a network error) is retried after a backoff pause.
 */
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let fatalMessage: string | null = null;
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        fatalMessage = `register answered HTTP ${response.status}: ${await response.text()}`;
      }
    } catch {
      // Unreachable env, aborted request, unreadable body: all retryable, handled below.
    }
    if (fatalMessage !== null) throw new Error(fatalMessage);
    await pause(backoffMs(failures));
    failures += 1;
  }
}

/**
 * Ask the env whether the trial is over, again and again, until it says yes.
 * The env answers at once ({"done": false} while the suite runs), so this is a poll
 * with backoff between rounds; a failed poll is just another "not yet".
 */
async function awaitDoneSignal(): Promise<void> {
  let failures = 0;
  for (;;) {
    let finished = false;
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        finished = payload.done === true;
      }
    } catch {
      // No usable answer yet means the trial is still running.
    }
    if (finished) return;
    await pause(backoffMs(failures));
    failures += 1;
  }
}

/** Bind, announce, wait: the full life of the entry process, in that order. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });

  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  try {
    await announcePort(bound.port);
    process.stdout.write('[entry] registered; waiting for the env to say done\n');

    await awaitDoneSignal();
    process.stdout.write('[entry] done\n');
  } finally {
    // Release the listening socket on every path out of here — including a register
    // contract error — instead of leaving cleanup to process teardown.
    server.close();
  }
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
