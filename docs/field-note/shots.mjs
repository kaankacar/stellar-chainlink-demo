#!/usr/bin/env node
/**
 * Demo footage for the DR-4 Pyth Pro field note: named stills (PNG) and short
 * clips (WebM), rendered headless with puppeteer-core and the system Chrome
 * from the run logs in docs/field-note/runs/ and the built web page served
 * locally.
 *
 *   pnpm build && pnpm exec vite preview --port 4173 --strictPort   # the page, in another shell
 *   node docs/field-note/shots.mjs              # stills and clips
 *   node docs/field-note/shots.mjs --stills     # PNGs only  -> docs/field-note/shots/
 *   node docs/field-note/shots.mjs --clips      # WebMs only -> docs/field-note/clips/
 *   node docs/field-note/shots.mjs --only=board,mark   # names containing "board" or "mark"
 *
 * Run it from the repo root so `puppeteer-core` resolves from node_modules.
 * CHROME_PATH overrides the Chrome binary, SHOTS_BASE_URL the page (default
 * http://localhost:4173), SHOTS_THEME=dark renders the page in dark mode.
 * Clips shell out to ffmpeg (must be on PATH).
 *
 * 05-board, 06-mark and the page clips need fresh prices on the board: run
 * them while scripts/keeper.ts is pushing, or within max_age (120 s) of the
 * last push. Later the pills read "stale" and mark() returns error #1 Stale.
 * 08-keeper needs the finished keeper log (its "== Summary" section).
 */
import puppeteer from 'puppeteer-core';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = (process.env.SHOTS_BASE_URL ?? 'http://localhost:4173').replace(/\/$/, '');
const THEME = process.env.SHOTS_THEME === 'dark' ? 'dark' : 'light';
const SHOTS_DIR = resolve(HERE, 'shots');
const CLIPS_DIR = resolve(HERE, 'clips');
const STILL_PREFIX = 'DR-4_pyth-field-note_';
const W = 1920;
const H = 1080;
// The page is a 1024px column. CSS zoom 1.5 on <html> lays it out as if the
// viewport were 1280x720 and paints it 1.5x, so the text is legible in a
// 1920x1080 frame. (An emulated deviceScaleFactor would do the same for
// screenshots, but puppeteer's screencast ignores it and records 1280x720.)
const PAGE_ZOOM = 1.5;
const NAV_TIMEOUT = 60_000;
const TEXT_TIMEOUT = 60_000;
const MAX_LINES = 40; // log lines per terminal still
const MARK_QTY = '2.5';
const MARK_FEED_ID = 1; // BTC/USD

const CARD = resolve(HERE, 'card/card.png');
const RECON_LOG = resolve(HERE, 'runs/run0-recon.log');
const DEPLOY_LOG = resolve(HERE, 'runs/run1-deploy.log');
const PUSH_LOG = resolve(HERE, 'runs/run2-push.log');
const KEEPER_LOG = resolve(HERE, 'runs/run3-keeper.log');
const GOLD_LOG = resolve(HERE, 'runs/run4-keeper-gold-break.log');
const TRIAL_LOG = resolve(HERE, 'runs/run5-keeper-after-pages.log');
const DEPLOYMENTS = JSON.parse(readFileSync(resolve(HERE, '../../src/deployments.json'), 'utf8'));
const PRICE_BOARD = DEPLOYMENTS.testnet?.priceBoard ?? 'CBRQGQDIALJKNXN4NY2C7UQ3KUUTZ6KCQCNJYYW3LAZ4QN45JXSEUN5I';
const EXPLORER_URL = `https://stellar.expert/explorer/testnet/contract/${PRICE_BOARD}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLines = (file) => readFileSync(file, 'utf8').replace(/\n$/, '').split('\n');
const stillPath = (step) => resolve(SHOTS_DIR, `${STILL_PREFIX}${step}.png`);
const clipPath = (name) => resolve(CLIPS_DIR, `${name}.webm`);
const rel = (p) => relative(process.cwd(), p);

// ---------------------------------------------------------------------------
// Log slicing. Every line is "2026-10-15T12:53:03Z  message"; a section starts
// with "== title" and the blank line before the next section belongs to it.

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)(?:  (.*))?$/;
const isSectionHeader = (l) => /^\S+\s+== /.test(l);
const message = (l) => { const m = STAMP.exec(l); return m ? (m[2] ?? '') : l; };
const isBlank = (l) => !message(l).trim();

function trimBlanks(lines) {
  const out = [...lines];
  while (out.length && isBlank(out[0])) out.shift();
  while (out.length && isBlank(out[out.length - 1])) out.pop();
  return out;
}

/** The "== title" sections of `lines`, in the order given, each up to the next section header. */
function sections(lines, titles, file) {
  const out = [];
  for (const title of titles) {
    const start = lines.findIndex((l) => message(l).startsWith(`== ${title}`));
    if (start < 0) throw new Error(`"== ${title}" not found in ${rel(file)}`);
    let end = lines.findIndex((l, i) => i > start && isSectionHeader(l));
    if (end < 0) end = lines.length;
    out.push(...lines.slice(start, end));
  }
  return out;
}

/** Lines from the first match of `from` up to (not including) the first later match of `until`. */
function between(lines, from, until, file) {
  const start = lines.findIndex((l) => from.test(l));
  if (start < 0) throw new Error(`${from} not found in ${rel(file)}`);
  let end = lines.findIndex((l, i) => i > start && until.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

/** Cut a line longer than `max` characters and mark the cut. */
const clipLine = (l, max) => (l.length > max ? `${l.slice(0, max)} …` : l);

/** Keep a long log within MAX_LINES: the first `head` lines, a marker, then the tail. */
function headTail(lines, head) {
  if (lines.length <= MAX_LINES) return lines;
  const tail = lines.slice(lines.length - (MAX_LINES - head - 1));
  return [...lines.slice(0, head), `… ${lines.length - head - tail.length} lines omitted …`, ...tail];
}

// ---------------------------------------------------------------------------
// A fake terminal: dark page, light monospace text, one div per line. The
// timestamp is dimmed, section headers are brighter, highlighted lines are warm.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function terminalRow(l, highlight) {
  const m = STAMP.exec(l);
  const cls = ['l'];
  if (isSectionHeader(l)) cls.push('sec');
  if (highlight && highlight.test(l)) cls.push('hi');
  const body = m ? `<span class="ts">${esc(m[1])}</span>  ${esc(m[2] ?? '')}` : esc(l);
  return `<div class="${cls.join(' ')}">${body || ' '}</div>`;
}

function terminalHtml(lines, { title = '', highlight = null } = {}) {
  const rows = lines.map((l) => terminalRow(l, highlight)).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #0c0f14; }
  body { box-sizing: border-box; min-height: ${H}px; padding: 28px 56px; color: #d7dde6;
         font: 20px/1.3 ui-monospace, "SF Mono", Menlo, Monaco, "Courier New", monospace; tab-size: 8; }
  .t { color: #7d8794; margin-bottom: 14px; }
  .l { white-space: pre-wrap; word-break: break-all; }
  .ts { color: #66758a; }
  .sec { color: #f2f6fa; font-weight: 600; }
  .hi { color: #ffd27f; background: #3a2708; margin: 0 -12px; padding: 0 12px; border-radius: 4px; }
  .hi .ts { color: #c49a52; }
  .cur { display: inline-block; width: .6em; height: 1.05em; background: #d7dde6; vertical-align: -0.15em;
         animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
</style></head>
<body>${title ? `<div class="t">${esc(title)}</div>` : ''}
${rows}
</body></html>`;
}

/** Shrink the terminal font (from 20px, never below 13px) until the text fits in one 1080px frame. */
async function fitTerminal(page) {
  return page.evaluate((h) => {
    let px = 20;
    while (document.documentElement.scrollHeight > h && px > 13) {
      px -= 0.5;
      document.body.style.fontSize = `${px}px`;
    }
    return px;
  }, H);
}

async function renderTerminal(page, lines, opts) {
  await page.setContent(terminalHtml(lines, opts), { waitUntil: 'load' });
  return fitTerminal(page);
}

// ---------------------------------------------------------------------------
// Page helpers.

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const ua = await browser.userAgent();
  await page.setUserAgent(ua.replace('HeadlessChrome', 'Chrome'));
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: THEME }]);
  page.setDefaultTimeout(NAV_TIMEOUT);
  return page;
}

/** Zoom the page. Call it after every navigation; the style lives on the document. */
async function zoomPage(page, zoom = PAGE_ZOOM) {
  await page.evaluate((z) => {
    document.documentElement.style.zoom = String(z);
  }, zoom);
}

/** Navigate, zoom, wait for network idle, give the RPC simulations a moment, wait for idle again. Never throws. */
async function open(page, url, { waitUntil = 'networkidle0', zoom = PAGE_ZOOM } = {}) {
  const notes = [];
  await page.goto(url, { waitUntil, timeout: NAV_TIMEOUT }).catch((e) => notes.push(`goto: ${e.message.split('\n')[0]}`));
  if (zoom !== 1) await zoomPage(page, zoom).catch(() => notes.push('zoom failed'));
  await sleep(1500);
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 30_000 }).catch(() => notes.push('network never idle'));
  return notes.join('; ');
}

/** Poll document.body.innerText until it matches `re`. Returns false on timeout instead of throwing. */
async function waitForText(page, re, timeout = TEXT_TIMEOUT) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (re.test(text)) return true;
    await sleep(500);
  }
  return false;
}

/** The board table: how many rows exist, hold a price, and show the "fresh" pill. */
async function boardRows(page) {
  return page
    .evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')].map((tr) => tr.innerText);
      return {
        n: rows.length,
        filled: rows.filter((t) => !t.includes('not stored yet')).length,
        fresh: rows.filter((t) => /\bfresh\b/.test(t)).length,
      };
    })
    .catch(() => ({ n: 0, filled: 0, fresh: 0 }));
}

/** Wait until all four board rows hold a price. Returns the last count either way. */
async function waitForRows(page, timeout = TEXT_TIMEOUT) {
  const t0 = Date.now();
  let last = { n: 0, filled: 0, fresh: 0 };
  while (Date.now() - t0 < timeout) {
    last = await boardRows(page);
    if (last.n === 4 && last.filled === 4) return last;
    await sleep(500);
  }
  return last;
}

/** "" when the board is complete and fresh, else a WARN prefix for the shot note. */
function rowsWarning(rows) {
  if (rows.filled < 4) return `WARN: ${rows.filled}/4 board rows filled; `;
  if (rows.fresh < 4) return `WARN: only ${rows.fresh}/4 rows fresh (keeper stopped?); `;
  return '';
}

/** Document coordinates of the <section> whose <h2> reads `heading`, or null. */
async function sectionRect(page, heading) {
  return page.evaluate((heading) => {
    const h2 = [...document.querySelectorAll('section h2')].find((e) => e.textContent.trim() === heading);
    if (!h2) return null;
    const r = h2.closest('section').getBoundingClientRect();
    return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, height: r.height };
  }, heading);
}

/** Scroll so the section is fully in view: stay at the top when it already fits, else put its top near the top edge. */
async function showSection(page, heading, margin = 20) {
  const r = await sectionRect(page, heading);
  if (!r) return false;
  const viewportH = await page.evaluate(() => window.innerHeight);
  const y = r.bottom <= viewportH ? 0 : Math.max(0, r.top - margin);
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await sleep(500);
  return true;
}

/** Fill the mark calculator (feed select, quantity) and submit. Returns true when a result (or error) showed. */
async function runMark(page, feedId, qty, { typeDelay = 0 } = {}) {
  await page.select('select', String(feedId));
  const input = await page.$('input[inputmode="decimal"]');
  if (!input) throw new Error('quantity input not found');
  // A triple click does not select the default "100" in headless Chrome; select() does.
  await input.evaluate((el) => { el.focus(); el.select(); });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(qty, { delay: typeDelay });
  const typed = await input.evaluate((el) => el.value);
  if (typed !== qty) throw new Error(`quantity input reads "${typed}" after typing "${qty}"`);
  await sleep(typeDelay ? 700 : 100);
  await page.keyboard.press('Enter'); // submits the form, same as the "Value it" button
  return waitForText(page, /Raw i128:|mark failed/, 30_000);
}

/** Linear scroll by `px` over `ms`, stepped at ~30 fps from inside the page. */
async function slowScroll(page, px, ms) {
  await page.evaluate(
    async (px, ms) => {
      const start = window.scrollY;
      const t0 = performance.now();
      for (;;) {
        const t = Math.min(1, (performance.now() - t0) / ms);
        window.scrollTo(0, start + px * t);
        if (t >= 1) return;
        await new Promise((r) => setTimeout(r, 33));
      }
    },
    px,
    ms,
  );
}

/** Max distance the page can still scroll down from its current position. */
const scrollRoom = (page) => page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - window.innerHeight - window.scrollY));

/**
 * Chrome only emits a screencast frame when something repaints, and puppeteer's
 * recorder needs at least two frames before it writes anything, so a static
 * hold would record nothing. A 1px dot at 2% opacity that flips colour every
 * 100 ms keeps the frames coming without being visible. Re-inject it after a
 * navigation.
 */
async function startHeartbeat(page) {
  await page
    .evaluate(() => {
      document.getElementById('__shots_heartbeat')?.remove();
      const d = document.createElement('div');
      d.id = '__shots_heartbeat';
      d.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:.02;background:#000;pointer-events:none;z-index:2147483647';
      document.body.appendChild(d);
      let on = false;
      window.__shotsHeartbeat = setInterval(() => {
        on = !on;
        d.style.background = on ? '#fff' : '#000';
      }, 100);
    })
    .catch(() => undefined);
}

async function stopHeartbeat(page) {
  await page
    .evaluate(() => {
      clearInterval(window.__shotsHeartbeat);
      document.getElementById('__shots_heartbeat')?.remove();
    })
    .catch(() => undefined);
}

/**
 * Record `fn` to `file`. puppeteer streams ffmpeg's output through a pipe, so
 * the raw WebM has no duration or cues; a stream-copy remux adds them so
 * editors and the ffmpeg concat step see a proper length.
 */
async function record(page, file, fn) {
  const raw = file.replace(/\.webm$/, '.raw.webm');
  await startHeartbeat(page);
  const recorder = await page.screencast({ path: raw, fps: 30, overwrite: true });
  const t0 = Date.now();
  try {
    await fn();
  } finally {
    await recorder.stop();
    await stopHeartbeat(page);
  }
  const mux = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-c', 'copy', file], { encoding: 'utf8' });
  if (mux.status === 0) unlinkSync(raw);
  else renameSync(raw, file); // keep the raw recording rather than lose the clip
  const secs = `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  return mux.status === 0 ? secs : `${secs}, remux failed: ${(mux.stderr || mux.error?.message || '').trim().split('\n')[0]}`;
}

// ---------------------------------------------------------------------------
// Shots. Each `run(page)` returns a note; a note starting with "WARN" marks a
// partial render (the file is still written), "SKIP" means no file.

/** A still made from a run log: `pick(lines)` chooses the lines, rendered as a terminal. */
function logStill(name, file, title, pick, highlight) {
  return {
    name,
    file: stillPath(name),
    async run(page) {
      const lines = trimBlanks(pick(readLines(file)));
      const px = await renderTerminal(page, lines, { title, highlight });
      const hits = highlight ? lines.filter((l) => highlight.test(l)).length : 0;
      await page.screenshot({ path: this.file });
      const over = lines.length > MAX_LINES ? `WARN: ${lines.length} lines is over ${MAX_LINES}; ` : '';
      const miss = highlight && !hits ? 'WARN: highlight matched nothing; ' : '';
      return `${over}${miss}${lines.length} lines at ${px}px${hits ? `, ${hits} highlighted` : ''}`;
    },
  };
}

const logTitle = (file, note) => `$ cat ${rel(file)}   # ${note}`;

const stills = [
  {
    name: '00-card',
    file: stillPath('00-card'),
    async run() {
      copyFileSync(CARD, this.file);
      return `copied from ${rel(CARD)}`;
    },
  },
  logStill(
    '01-recon',
    RECON_LOG,
    logTitle(RECON_LOG, 'trusted signers, the signed fixture replayed by simulation, one bit flipped'),
    (lines) => [...lines.slice(0, 2), '', ...sections(lines, ['Trusted signers', 'Fixture', 'verify_update by simulation', 'Tampered bit'], RECON_LOG)],
    /contract error #6/,
  ),
  logStill(
    '02-entitled',
    RECON_LOG,
    logTitle(RECON_LOG, 'symbols: tracked feeds, not entitled on the free key, REST without a key (schedules cut)'),
    (lines) => [
      ...between(lines, /== Symbols/, /fixture feeds:/, RECON_LOG).map((l) => clipLine(l, 230)),
      '',
      ...sections(lines, ['REST without a key'], RECON_LOG),
    ],
    /HTTP 403/,
  ),
  logStill(
    '03-deploy',
    DEPLOY_LOG,
    logTitle(DEPLOY_LOG, 'pnpm run deploy --network testnet: upload the wasm, create the contract, check config()'),
    (lines) => lines,
    /^\S+\s+contract C[A-Z2-7]{55}$/,
  ),
  logStill(
    '04-push',
    PUSH_LOG,
    logTitle(PUSH_LOG, 'pnpm run push --network testnet: fetch a signed update, push it, read it back by simulation'),
    (lines) => lines,
    /stored 4 feed\(s\)/,
  ),
  {
    name: '05-board',
    file: stillPath('05-board'),
    async run(page) {
      const nav = await open(page, `${BASE}/`);
      const rows = await waitForRows(page);
      await showSection(page, 'Board');
      await page.screenshot({ path: this.file });
      return `${rowsWarning(rows)}${rows.fresh}/4 rows fresh ${nav}`.trim();
    },
  },
  {
    name: '06-mark',
    file: stillPath('06-mark'),
    async run(page) {
      const nav = await open(page, `${BASE}/`);
      const rows = await waitForRows(page);
      const shown = await runMark(page, MARK_FEED_ID, MARK_QTY);
      await showSection(page, 'Mark calculator');
      await page.screenshot({ path: this.file });
      const failed = await page.evaluate(() => /mark failed/.test(document.body.innerText));
      if (!shown) return `WARN: no mark result within 30 s ${nav}`.trim();
      if (failed) return `WARN: mark returned an error (stale board?) ${nav}`.trim();
      return `${rowsWarning(rows)}${MARK_QTY} BTC/USD valued ${nav}`.trim();
    },
  },
  {
    name: '07-how-it-works',
    file: stillPath('07-how-it-works'),
    async run(page) {
      const nav = await open(page, `${BASE}/`);
      const ok = await waitForText(page, /The verifier is stateless/, 30_000);
      const found = await showSection(page, 'How it works');
      await page.screenshot({ path: this.file });
      return ok && found ? nav : `WARN: How it works section not found ${nav}`.trim();
    },
  },
  logStill(
    '08-keeper',
    KEEPER_LOG,
    logTitle(KEEPER_LOG, 'pnpm run keeper --network testnet --every 30 --minutes 10: one line per round, then the summary'),
    (lines) => {
      if (!lines.some((l) => message(l).startsWith('== Summary'))) throw new Error(`no "== Summary" in ${rel(KEEPER_LOG)} yet: the keeper is still running`);
      return headTail(lines, 3);
    },
    /^\S+\s+rounds \d+, successes \d+/,
  ),
  logStill(
    '10-gold-break',
    GOLD_LOG,
    logTitle(GOLD_LOG, 'pnpm run keeper --network testnet --every 60 --minutes 20 during the gold break (21:00 to 22:00 UTC): XAU/USD carried forward, skipped'),
    (lines) => {
      if (!lines.some((l) => message(l).startsWith('== Summary'))) throw new Error(`no "== Summary" in ${rel(GOLD_LOG)} yet: the keeper is still running`);
      return headTail(lines, 3);
    },
    /stored 3|carried|skip|^\S+\s+rounds \d+, successes \d+/,
  ),
  logStill(
    '11-trial-expired',
    TRIAL_LOG,
    logTitle(TRIAL_LOG, 'pnpm keeper --network testnet --every 60 --minutes 15 on 9 November, 25 days after the first call: the free trial is over'),
    (lines) => lines,
    /403 Not entitled|no feed left/,
  ),
  {
    name: '09-explorer',
    file: stillPath('09-explorer'),
    async run(page) {
      const nav = await open(page, EXPLORER_URL, { waitUntil: 'load', zoom: 1 });
      const ok = await waitForText(page, new RegExp(PRICE_BOARD), 20_000);
      const wall = await page.evaluate(() => /Just a moment|Verify you are human|Checking your browser|Access denied|Attention Required/i.test(document.body.innerText));
      if (!ok || wall) return `SKIP: stellar.expert ${wall ? 'showed a bot wall' : 'did not render the contract page'} for headless Chrome ${nav}`.trim();
      await page.screenshot({ path: this.file });
      return `contract page rendered ${nav}`.trim();
    },
  },
];

const clips = [
  {
    name: 'clip-a-board',
    file: clipPath('clip-a-board'),
    async run(page) {
      // Recording starts before navigation, so the clip shows the page load and the rows filling in.
      let rows = { n: 0, filled: 0, fresh: 0 };
      const took = await record(page, this.file, async () => {
        const t0 = Date.now();
        await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: NAV_TIMEOUT });
        await zoomPage(page);
        await startHeartbeat(page);
        rows = await waitForRows(page, 20_000);
        // Hold while the ages tick and one 10 s refresh goes by.
        await sleep(Math.max(3000, 13_000 - (Date.now() - t0)));
      });
      return `${rowsWarning(rows)}${took}`;
    },
  },
  {
    name: 'clip-b-mark',
    file: clipPath('clip-b-mark'),
    async run(page) {
      await open(page, `${BASE}/`);
      const rows = await waitForRows(page);
      await showSection(page, 'Mark calculator');
      let shown = false;
      const took = await record(page, this.file, async () => {
        const t0 = Date.now();
        await sleep(1200);
        shown = await runMark(page, MARK_FEED_ID, MARK_QTY, { typeDelay: 220 });
        await sleep(Math.max(3000, 10_000 - (Date.now() - t0)));
      });
      return `${rowsWarning(rows)}${shown ? '' : 'WARN: no mark result; '}${took}`;
    },
  },
  {
    name: 'clip-c-push',
    file: clipPath('clip-c-push'),
    async run(page) {
      const lines = trimBlanks(readLines(PUSH_LOG));
      const highlight = /stored 4 feed\(s\)/;
      const title = logTitle(PUSH_LOG, 'pnpm run push --network testnet');
      // Lay out the full log once to pick the font size, then clear it and type it back line by line.
      const px = await renderTerminal(page, lines, { title, highlight });
      await page.evaluate(() => {
        document.querySelectorAll('.l').forEach((e) => e.remove());
        const cur = document.createElement('div');
        cur.className = 'l';
        cur.id = '__cursor';
        cur.innerHTML = '<span class="cur"></span>';
        document.body.appendChild(cur);
      });
      const perLine = Math.round((15_000 - 700 - 2500) / lines.length);
      const took = await record(page, this.file, async () => {
        await sleep(700);
        for (const line of lines) {
          await page.evaluate((html) => document.getElementById('__cursor').insertAdjacentHTML('beforebegin', html), terminalRow(line, highlight));
          await sleep(perLine);
        }
        await sleep(2500);
      });
      return `${lines.length} lines at ${px}px, ${perLine} ms per line, ${took}`;
    },
  },
  {
    name: 'clip-d-how',
    file: clipPath('clip-d-how'),
    async run(page) {
      await open(page, `${BASE}/`);
      const ok = await waitForText(page, /The verifier is stateless/, 30_000);
      const r = await sectionRect(page, 'How it works');
      if (!r) throw new Error('How it works section not found');
      const viewportH = await page.evaluate(() => window.innerHeight);
      // Start a little above the section, end with its bottom and the start of the footer in view.
      const start = Math.max(0, r.top - 20 - 400);
      await page.evaluate((y) => window.scrollTo(0, y), start);
      await sleep(300);
      const room = await scrollRoom(page);
      const distance = Math.min(room, Math.max(300, r.bottom + 120 - viewportH - start));
      const took = await record(page, this.file, async () => {
        await sleep(1000);
        await slowScroll(page, distance, 8000);
        await sleep(1200);
      });
      return `${ok ? '' : 'WARN: section text not shown; '}scrolled ${Math.round(distance)}px, ${took}`;
    },
  },
];

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const wantStills = argv.includes('--stills') || !argv.includes('--clips');
const wantClips = argv.includes('--clips') || !argv.includes('--stills');
const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean);
const selected = [...(wantStills ? stills : []), ...(wantClips ? clips : [])].filter((s) => !only || only.some((o) => s.name.includes(o)));
if (!selected.length) {
  console.error('nothing selected; use --stills, --clips and/or --only=<name part>[,<name part>]');
  process.exit(2);
}

mkdirSync(SHOTS_DIR, { recursive: true });
mkdirSync(CLIPS_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--no-sandbox', `--window-size=${W},${H}`, '--hide-scrollbars', '--force-color-profile=srgb'],
});

const tally = { ok: 0, warn: 0, skip: 0, fail: 0 };
try {
  for (const shot of selected) {
    const t0 = Date.now();
    let page = null;
    try {
      page = await newPage(browser);
      const note = (await shot.run(page)) ?? '';
      const status = note.startsWith('WARN') ? 'WARN' : note.startsWith('SKIP') ? 'SKIP' : 'OK  ';
      tally[status.trim().toLowerCase()] += 1;
      const size = existsSync(shot.file) ? `${(statSync(shot.file).size / 1024).toFixed(0)} KB` : '-';
      const secs = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
      console.log(`${status}  ${shot.name.padEnd(16)} ${rel(shot.file).padEnd(58)} ${size.padStart(8)} ${secs.padStart(7)}  ${note}`);
    } catch (e) {
      tally.fail += 1;
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      console.log(`FAIL  ${shot.name.padEnd(16)} ${msg}`);
    } finally {
      if (page) await page.close().catch(() => undefined);
    }
  }
} finally {
  await browser.close();
}
console.log(`${tally.ok} ok, ${tally.warn} partial, ${tally.skip} skipped, ${tally.fail} failed`);
process.exit(tally.fail ? 1 : 0);
