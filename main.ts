// main.ts — the forge's entry point: bring the HTTP app up on a kernel-chosen
// port, tell the trial suite where it landed, and keep serving until the suite
// says it is finished.
//
// The lifecycle is a small wire contract between this process and the suite
// process that runs beside it in the trial pod (the kit's RULES.txt states it
// and the suite's wire module pins the numbers down):
//
//   1. Bind port 0 so the kernel picks a free port. Port 8080 belongs to the
//      suite and is never ours to take.
//   2. POST {"port": <the bound port>} to $MAKEFUN_ENV_URL/register. The
//      suite notes the address the request arrived from, dials that address
//      and port back, and drives the forge from there. A first registration
//      is answered 200 {"ok": true}; a repeat is answered 409, which from
//      where we stand means the same thing: the suite has our address.
//   3. Poll GET $MAKEFUN_ENV_URL/done. The suite answers {"done": false} at
//      once — it never holds a poll open — until it has run every check and
//      written its export; then it answers {"done": true}.
//   4. On {"done": true}, shut down and exit 0.
//
// Registration has to land inside the suite's boot budget (20 s), so the
// announcement retries for a while in case the suite is still starting. The
// gap between done polls doubles from 250 ms up to a 2 s ceiling, and no
// single poll may hang longer than 30 s.
//
// With MAKEFUN_ENV_URL unset there is no suite to report to: that is a local
// run (the kit's sdk/run.ts drives a server started by hand), so the forge
// simply serves until it is stopped.

import type { Server } from 'node:http';
import { createApp } from './app.ts';

/** Where the suite accepts our port announcement. */
const REGISTER_ROUTE = '/register';
/** Where the suite tells us it has finished. */
const DONE_ROUTE = '/done';

/** How long one register attempt may take before it counts as a miss. */
const REGISTER_ATTEMPT_TIMEOUT_MS = 5_000;
/** The pause between two register attempts. */
const REGISTER_GAP_MS = 250;
/** How long to keep trying to register, counted from the first attempt. */
const REGISTER_WINDOW_MS = 15_000;

/** The first pause between two done polls. */
const FIRST_POLL_GAP_MS = 250;
/** The longest pause between two done polls. */
const LONGEST_POLL_GAP_MS = 2_000;
/** How long one done poll may take before it counts as "not done yet". */
const POLL_TIMEOUT_MS = 30_000;

/** The exit code the contract asks for once the suite is done. */
const EXIT_OK = 0;
/** The exit code for a boot that never got the forge listening. */
const EXIT_FAILURE = 1;

/** A one-line progress note; stderr, so stdout stays the suite's business. */
function note(line: string): void {
  process.stderr.write(`[forge] ${line}\n`);
}

/** Sleep for `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The suite's origin from MAKEFUN_ENV_URL, with any trailing slashes removed
 * so routes can be appended directly. An unset or blank variable means there
 * is no suite: the empty string.
 */
function suiteOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined) return '';
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Announce our port to the suite. The suite may still be starting when we
 * first try, so a failed attempt is retried until the window closes; a 200
 * (recorded) or a 409 (our announcement already landed once) both end the
 * loop. Giving up is quiet: the forge keeps serving either way, and whether a
 * late registration still counts is the suite's call, not ours.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  const windowEndsAt = Date.now() + REGISTER_WINDOW_MS;
  for (;;) {
    try {
      const reply = await fetch(`${origin}${REGISTER_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REGISTER_ATTEMPT_TIMEOUT_MS),
      });
      // Drain the reply so its socket is released before we move on.
      await reply.arrayBuffer().catch(() => undefined);
      if (reply.status === 200 || reply.status === 409) return;
    } catch {
      // The suite is not answering yet; the next attempt comes after a pause.
    }
    if (Date.now() >= windowEndsAt) return;
    await pause(REGISTER_GAP_MS);
  }
}

/** The pause after the `misses`-th not-done answer in a row: doubling, capped. */
function pollGapMs(misses: number): number {
  return Math.min(LONGEST_POLL_GAP_MS, FIRST_POLL_GAP_MS * 2 ** misses);
}

/**
 * Poll the suite's done endpoint until it answers {"done": true}. A failed
 * or malformed answer says nothing about the suite's progress, so it counts
 * as one more miss and the polling carries on.
 */
async function waitForSuiteToFinish(origin: string): Promise<void> {
  let misses = 0;
  for (;;) {
    let finished = false;
    try {
      const reply = await fetch(`${origin}${DONE_ROUTE}`, {
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
      const payload: unknown = await reply.json().catch(() => null);
      finished =
        typeof payload === 'object' &&
        payload !== null &&
        (payload as { done?: unknown }).done === true;
    } catch {
      finished = false;
    }
    if (finished) return;
    await pause(pollGapMs(misses));
    misses += 1;
  }
}

/**
 * Close the server and leave with the contract's exit code. The exit happens
 * as soon as the close completes; the timer is only a fallback, in case a
 * keep-alive socket the suite still holds keeps the close waiting.
 */
function shutDown(server: Server): void {
  const fallback = setTimeout(() => {
    process.exit(EXIT_OK);
  }, 1_000);
  server.close(() => {
    clearTimeout(fallback);
    process.exit(EXIT_OK);
  });
  server.closeIdleConnections();
}

/** Boot the forge and run the lifecycle described at the top of this file. */
async function startForge(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the forge did not land on a TCP port');
  }
  note(`serving on port ${address.port}`);

  const origin = suiteOrigin();
  if (origin === '') {
    note('MAKEFUN_ENV_URL is not set: serving standalone, with no suite to report to');
    return;
  }
  await announcePort(origin, address.port);
  note('the suite has our address; waiting for it to finish');
  await waitForSuiteToFinish(origin);
  note('the suite reports done; shutting down');
  shutDown(server);
}

startForge().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[forge] fatal: ${message}\n`);
  process.exit(EXIT_FAILURE);
});
