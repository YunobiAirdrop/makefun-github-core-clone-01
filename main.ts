// Entry lifecycle: bind an ephemeral port, register it with the env at
// $MAKEFUN_ENV_URL, then poll the env's /done until the trial is over and
// exit 0. The forge itself lives in app.ts.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function postRegister(port: number): Promise<void> {
  let delay = 200;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await wait(delay);
    delay = Math.min(2_000, delay * 2);
  }
}

async function pollUntilDone(): Promise<void> {
  let delay = 200;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // env not answering yet: keep polling
    }
    await wait(delay);
    delay = Math.min(2_000, delay * 2);
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  process.stderr.write('[forge] could not bind an ephemeral port\n');
  process.exit(1);
}
process.stdout.write(`[forge] listening on ${address.port}\n`);
await postRegister(address.port);
process.stdout.write('[forge] registered; waiting for done\n');
await pollUntilDone();
server.close();
process.stdout.write('[forge] done\n');
process.exit(0);
