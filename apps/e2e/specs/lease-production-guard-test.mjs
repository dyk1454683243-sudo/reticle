// The production policy stops a refused request in a REAL headless Chromium, before it leaves.
// Prints through process.stdout.write: the repository asks for no console logging.
//
// The unit tests pass a fake page that records the guard. Only a real browser can show that a
// request from a control with a harmless name ("Done") gets the 403 and never reaches the site.
// Serves its own page, so it needs no app from run-ci.sh.
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserPool, playwrightLauncher } from '@reticlehq/server';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { ProductionDrive } = await import(
  pathToFileURL(path.join(ROOT, 'server/dist/portal/production/production-drive.js')).href
);

let pass = 0,
  fail = 0;
const say = (line) => process.stdout.write(`${line}\n`);
const chk = (label, ok, detail = '') => {
  say(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const PAGE = `<!doctype html><title>guard</title>
<button id="done">Done</button><button id="load">Load</button><output id="out"></output>
<script>
  const show = (r) => { document.getElementById('out').textContent = String(r.status); };
  document.getElementById('done').onclick = () => fetch('/v1/invites', { method: 'POST' }).then(show);
  document.getElementById('load').onclick = () => fetch('/v1/runs').then(show);
</script>`;

const reached = [];
const server = createServer((req, res) => {
  reached.push(`${req.method} ${req.url}`);
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const APP = `http://127.0.0.1:${server.address().port}/`;
const ORIGIN = new URL(APP).origin;

const pages = [];
const launcher = async () => {
  const browser = await playwrightLauncher({ headless: true })();
  return {
    ...browser,
    newContext: async () => {
      const context = await browser.newContext();
      return {
        ...context,
        newPage: async () => {
          const page = await context.newPage();
          pages.push(page);
          return page;
        },
      };
    },
  };
};
let seq = 0;
const pool = new BrowserPool(launcher, { maxContexts: 2, genSessionId: () => `guard-${(seq += 1)}` });

/** Lease the page under a drive, press a button, and report what the page and the site saw. */
async function press(intent, button) {
  const drive = new ProductionDrive(
    { scope: 'act', origin: ORIGIN, expiresAt: Date.now() + 60_000, ...(intent ? { intent } : {}) },
    () => Date.now(),
  );
  const lease = await pool.acquire(APP);
  await pool.guardLease(lease.sessionId, (method, url) => drive.refuseRequest(method, url));
  const page = pages.at(-1);
  reached.length = 0;
  // The pool's page wrapper has no click; a real click event from the page is the same request.
  const status = await page.evaluate(`new Promise((resolve) => {
    const out = document.getElementById('out');
    new MutationObserver(() => resolve(out.textContent)).observe(out, { childList: true });
    document.getElementById('${button}').click();
  })`);
  await lease.release();
  return { status, reached: [...reached], pending: drive.takePending() };
}

say('\n=== production policy on the network, in a real headless Chromium ===');

const refused = await press(undefined, 'done');
chk('a POST to /v1/invites from a button named "Done" gets a 403', refused.status === '403', refused.status);
chk('…and never reaches the site', !refused.reached.some((r) => r.startsWith('POST /v1/invites')), refused.reached.join(', '));
chk('…and the next act is told which rule refused it', /send an invite or email/.test(refused.pending ?? ''), refused.pending);

const read = await press(undefined, 'load');
chk('a GET goes through untouched', read.status === '200' && read.reached.includes('GET /v1/runs'), read.reached.join(', '));

const allowed = await press('invite a teammate to the workspace', 'done');
chk('an intent that names the invite lets the POST reach the site', allowed.status === '200' && allowed.reached.includes('POST /v1/invites'), allowed.reached.join(', '));

const negated = await press('do not invite anybody', 'done');
chk('an intent that says not to invite still refuses it', negated.status === '403', negated.status);

await pool.shutdown();
server.close();
say(`\n${fail === 0 ? '✅' : '❌'} PRODUCTION GUARD: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
