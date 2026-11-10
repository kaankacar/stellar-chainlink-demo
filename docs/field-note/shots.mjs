#!/usr/bin/env node
/**
 * Demo footage for the DR-5 Chainlink field note: named stills (PNG) and short
 * clips (WebM), rendered headless with puppeteer-core and the system Chrome
 * from the run logs in docs/field-note/runs/ and the built web page served
 * locally.
 *
 *   pnpm build && pnpm exec vite preview --port 4173 --strictPort   # the page, in another shell
 *   node docs/field-note/shots.mjs              # stills and clips
 *   node docs/field-note/shots.mjs --stills     # PNGs only  -> docs/field-note/shots/
 *   node docs/field-note/shots.mjs --clips      # WebMs only -> docs/field-note/clips/
 *   node docs/field-note/shots.mjs --only=board,verify   # names containing "board" or "verify"
 *
 * Run it from the repo root so `puppeteer-core` resolves from node_modules.
 * CHROME_PATH overrides the Chrome binary, SHOTS_BASE_URL the page (default
 * http://localhost:4173), SHOTS_THEME=dark renders the page in dark mode.
 * Clips shell out to ffmpeg (must be on PATH).
 *
 * The page stills need src/deployments.json to name the testnet contract: the
 * board then fills its ten rows by simulation (the testnet RPC took 3 to 4 s
 * per call on 10 November, so the waits are generous). 07-watch needs the
 * finished watch log (its "== Summary" section) and says SKIP until then.
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
const STILL_PREFIX = 'DR-5_chainlink-field-note_';
const W = 1920;
const H = 1080;
// The page is a 1024px column. CSS zoom 1.5 on <html> lays it out as if the
// viewport were 1280x720 and paints it 1.5x, so the text is legible in a
// 1920x1080 frame. (An emulated deviceScaleFactor would do the same for
// screenshots, but puppeteer's screencast ignores it and records 1280x720.)
const PAGE_ZOOM = 1.5;
// The ten-row board is taller than one frame at zoom 1.5. For the two board
// stills the column is widened to this many CSS px (fewer wrapped lines per
// row) and the zoom is picked so the whole card fits the frame.
const WIDE_COLUMN = 1760;
const NAV_TIMEOUT = 60_000;
const TEXT_TIMEOUT = 90_000;
const ROWS_TIMEOUT = 150_000; // ten rows by simulation on the slow testnet RPC
const MAX_LINES = 40; // log lines per terminal still
const ASSET_COUNT = 10;

const CARD = resolve(HERE, 'card/card.png');
const RECON_LOG = resolve(HERE, 'runs/run0-recon.log');
const DEPLOY_LOG = resolve(HERE, 'runs/run1-deploy.log');
const REFRESH_LOG = resolve(HERE, 'runs/run2-refresh.log');
const SUBMIT_LOG = resolve(HERE, 'runs/run3-submit-expired.log');
const WATCH_LOG = resolve(HERE, 'runs/run4-watch.log');
const DEPLOYMENTS = JSON.parse(readFileSync(resolve(HERE, '../../src/deployments.json'), 'utf8'));
const TWO_CLOCKS = DEPLOYMENTS.testnet?.twoClocks ?? 'CDJTBGMNA4T2Q4IALTUQVNSUTFHISVQIDKMKNKW26AYJIM5QWFQ3I4FP';
const EXPLORER_URL = `https://stellar.expert/explorer/testnet/contract/${TWO_CLOCKS}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLines = (file) => readFileSync(file, 'utf8').replace(/\n$/, '').split('\n');
const stillPath = (step) => resolve(SHOTS_DIR, `${STILL_PREFIX}${step}.png`);
const clipPath = (name) => resolve(CLIPS_DIR, `${name}.webm`);
const rel = (p) => relative(process.cwd(), p);

// ---------------------------------------------------------------------------
// Log slicing. Every line is "2026-11-10T14:02:56Z  message"; a section starts
// with "== title" and the blank line before the next section belongs to it.

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)(?:  (.*))?$/;
const isSectionHeader = (l) => /^\S+\s+== /.test(l);
const message = (l) => { const m = STAMP.exec(l); return m ? (m[2] ?? '') : l; };
const isBlank = (l) => !message(l).trim();
const hasSection = (lines, title) => lines.some((l) => message(l).startsWith(`== ${title}`));

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
  .l { white-space: pre-wrap; overflow-wrap: anywhere; }
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

/** Widen the page column (the div under #root) to `px` CSS pixels. 0 restores the page's own width. */
async function widenColumn(page, px) {
  await page.evaluate((px) => {
    const col = document.querySelector('#root > div');
    if (col) col.style.maxWidth = px ? `${px}px` : '';
  }, px);
}

/** Navigate and zoom. The callers wait for the text they need. Never throws. */
async function open(page, url, { waitUntil = 'load', zoom = PAGE_ZOOM } = {}) {
  const notes = [];
  await page.goto(url, { waitUntil, timeout: NAV_TIMEOUT }).catch((e) => notes.push(`goto: ${e.message.split('\n')[0]}`));
  if (zoom !== 1) await zoomPage(page, zoom).catch(() => notes.push('zoom failed'));
  await sleep(500);
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

/** Click the first <button> whose text is `text`. Throws when there is none. */
async function clickButton(page, text) {
  const handle = await page.evaluateHandle(
    (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text) ?? null,
    text,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`button "${text}" not found`);
  await el.click();
}

/** The board rows: div grids inside the card titled "Board". A row is filled once its push leg shows the heartbeat countdown. */
async function boardRows(page) {
  return page
    .evaluate(() => {
      const card = [...document.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent.trim() === 'Board');
      const rows = card ? [...card.querySelectorAll('div.grid')].map((d) => d.innerText) : [];
      return {
        n: rows.length,
        filled: rows.filter((t) => /next heartbeat in|heartbeat overdue/.test(t)).length,
        fresh: rows.filter((t) => /\bfresh\b/.test(t)).length,
      };
    })
    .catch(() => ({ n: 0, filled: 0, fresh: 0 }));
}

/** Wait until all ten board rows hold a price. Returns the last count either way. */
async function waitForRows(page, timeout = ROWS_TIMEOUT) {
  const t0 = Date.now();
  let last = { n: 0, filled: 0, fresh: 0 };
  while (Date.now() - t0 < timeout) {
    last = await boardRows(page);
    if (last.n === ASSET_COUNT && last.filled === ASSET_COUNT) return last;
    await sleep(500);
  }
  return last;
}

/** "" when every row holds a price, else a WARN prefix for the shot note. */
function rowsWarning(rows) {
  if (rows.filled < ASSET_COUNT) return `WARN: ${rows.filled}/${ASSET_COUNT} board rows filled; `;
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

/**
 * Pick the largest zoom (at most `maxZoom`) at which the whole section fits
 * one frame with `margin` above and below, then scroll it into view. The
 * layout can change with the zoom (lines wrap), so measure again after each
 * step. Returns the zoom, or null when the section is missing.
 */
async function fitSection(page, heading, { margin = 16, maxZoom = PAGE_ZOOM, minZoom = 0.8 } = {}) {
  let zoom = maxZoom;
  for (let i = 0; i < 4; i++) {
    await zoomPage(page, zoom);
    await sleep(150);
    const r = await sectionRect(page, heading);
    if (!r) return null;
    const cssHeight = r.height / zoom;
    const next = Math.min(maxZoom, Math.max(minZoom, Math.floor(((H - 2 * margin) / cssHeight) * 100) / 100));
    if (Math.abs(next - zoom) < 0.005) break;
    zoom = next;
  }
  await showSection(page, heading, margin);
  return zoom;
}

/**
 * Draw a warm ring around the elements matching `selector` whose text matches
 * `re`: outside the box for small things like pills, inside it (`inset`) for
 * notices that sit flush against their neighbours. Returns how many.
 */
async function outline(page, selector, re, { inset = false } = {}) {
  return page.evaluate(
    (selector, source, flags, inset) => {
      const test = new RegExp(source, flags);
      let n = 0;
      for (const el of document.querySelectorAll(selector)) {
        if (!test.test(el.textContent.trim())) continue;
        if (inset) {
          el.style.boxShadow = 'inset 0 0 0 3px #f59e0b';
        } else {
          el.style.outline = '3px solid #f59e0b';
          el.style.outlineOffset = '3px';
        }
        n += 1;
      }
      return n;
    },
    selector,
    re.source,
    re.flags,
    inset,
  );
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

/** The two opening lines of the recon log (run id, "read-only") and a blank line. */
const reconHead = (lines) => [...lines.slice(0, 2), ''];

/** Open the page, wait for the ten testnet rows, click the verify box button `button` and wait for `result`. */
async function runVerify(page, button, result) {
  const nav = await open(page, `${BASE}/`);
  const rows = await waitForRows(page);
  await clickButton(page, button);
  const shown = await waitForText(page, result);
  return { nav, rows, shown };
}

const VERIFY_OK = /same fields as the browser decode|differs from the browser decode|failed with error/;
const VERIFY_TAMPERED = /#12 \(BadVerification\)/;

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
    '01-recon-feeds',
    RECON_LOG,
    logTitle(RECON_LOG, 'the testnet Data Feeds proxy by simulation: one contract, ten feeds, 18 decimals, two error probes'),
    (lines) => [...reconHead(lines), ...sections(lines, ['Data Feeds proxy testnet'], RECON_LOG)],
    /contract error #5[01]|truncation xlm/,
  ),
  logStill(
    '02-recon-verify',
    RECON_LOG,
    logTitle(RECON_LOG, 'the one public signed report: decoded, verified on testnet, one byte flipped, sent to mainnet'),
    (lines) => [...reconHead(lines), ...sections(lines, ['Sample report', 'verify by simulation', 'Tampered byte', 'Mainnet verifier'], RECON_LOG)],
    /contract error #12 |contract error #9 /,
  ),
  logStill(
    '03-recon-api',
    RECON_LOG,
    logTitle(RECON_LOG, 'Data Streams REST with the account credentials (401 on both environments), then the Candlestick API'),
    (lines) => [...reconHead(lines), ...sections(lines, ['Data Streams API', 'Candlestick'], RECON_LOG)],
    /HTTP 401/,
  ),
  logStill(
    '04-deploy',
    DEPLOY_LOG,
    logTitle(DEPLOY_LOG, 'pnpm run deploy --network testnet: the constructor args, the create transaction, config() and assets() read back'),
    (lines) => sections(lines, ['Deploy two-clocks to testnet', 'Create contract', 'Check config() and assets() by simulation'], DEPLOY_LOG),
    /^\S+\s+contract C[A-Z2-7]{55}$/,
  ),
  logStill(
    '05-refresh',
    REFRESH_LOG,
    logTitle(REFRESH_LOG, 'pnpm refresh --network testnet: ten push legs stored in one transaction'),
    (lines) => [...lines.slice(0, 2), '', ...sections(lines, ['refresh', 'Summary'], REFRESH_LOG)],
    /stored 10 of 10/,
  ),
  logStill(
    '06-submit-expired',
    SUBMIT_LOG,
    logTitle(SUBMIT_LOG, 'pnpm submit --network testnet --expect-expired: the verifier accepts the sample, the contract refuses it'),
    (lines) => lines,
    /contract error #23/,
  ),
  {
    name: '07-watch',
    file: stillPath('07-watch'),
    async run(page) {
      const all = readLines(WATCH_LOG);
      if (!hasSection(all, 'Summary')) return 'SKIP: watch still running';
      const lines = trimBlanks(headTail(all, 3));
      const highlight = /^\S+\s+rounds \d+, stored \d+/;
      const title = logTitle(WATCH_LOG, 'pnpm watch --network testnet --every 600 --minutes 120: one line per round, then the summary');
      const px = await renderTerminal(page, lines, { title, highlight });
      await page.screenshot({ path: this.file });
      const hits = lines.filter((l) => highlight.test(l)).length;
      return `${hits ? '' : 'WARN: highlight matched nothing; '}${lines.length} lines at ${px}px`;
    },
  },
  {
    name: '08-board',
    file: stillPath('08-board'),
    async run(page) {
      const nav = await open(page, `${BASE}/`);
      const rows = await waitForRows(page);
      await widenColumn(page, WIDE_COLUMN);
      const zoom = await fitSection(page, 'Board');
      await page.screenshot({ path: this.file });
      return `${rowsWarning(rows)}${rows.filled}/${ASSET_COUNT} rows, ${rows.fresh} fresh, zoom ${zoom} ${nav}`.trim();
    },
  },
  {
    name: '09-verify-sample',
    file: stillPath('09-verify-sample'),
    async run(page) {
      const { nav, rows, shown } = await runVerify(page, 'Verify by simulation', VERIFY_OK);
      const zoom = await fitSection(page, 'Verify a report');
      const marked = (await outline(page, 'span', /^expired \d+ days ago$/)) + (await outline(page, 'p', /submit_report/, { inset: true }));
      await page.screenshot({ path: this.file });
      const failed = await page.evaluate(() => /failed with error/.test(document.body.innerText));
      if (!shown) return `WARN: no verify result within ${TEXT_TIMEOUT / 1000} s ${nav}`.trim();
      if (failed) return `WARN: verify_report returned an error ${nav}`.trim();
      return `${rowsWarning(rows)}sample verified, ${marked} outlined, zoom ${zoom} ${nav}`.trim();
    },
  },
  {
    name: '10-verify-tampered',
    file: stillPath('10-verify-tampered'),
    async run(page) {
      const { nav, rows, shown } = await runVerify(page, 'Flip byte 479 and verify', VERIFY_TAMPERED);
      const zoom = await fitSection(page, 'Verify a report');
      const marked = await outline(page, 'p', VERIFY_TAMPERED, { inset: true });
      await page.screenshot({ path: this.file });
      if (!shown) return `WARN: no #12 within ${TEXT_TIMEOUT / 1000} s ${nav}`.trim();
      return `${rowsWarning(rows)}#12 BadVerification shown, ${marked} outlined, zoom ${zoom} ${nav}`.trim();
    },
  },
  {
    name: '11-mainnet-toggle',
    file: stillPath('11-mainnet-toggle'),
    async run(page) {
      const nav = await open(page, `${BASE}/`);
      const radio = await page.evaluateHandle(() => [...document.querySelectorAll('[role=radio]')].find((b) => b.textContent.trim() === 'Mainnet') ?? null);
      const el = radio.asElement();
      if (!el) throw new Error('Mainnet radio not found');
      await el.click();
      const rows = await waitForRows(page);
      const checked = await page.evaluate(() => [...document.querySelectorAll('[role=radio]')].find((b) => b.textContent.trim() === 'Mainnet')?.getAttribute('aria-checked') === 'true');
      await widenColumn(page, WIDE_COLUMN);
      const zoom = await fitSection(page, 'Board');
      await page.screenshot({ path: this.file });
      return `${checked ? '' : 'WARN: Mainnet radio not checked; '}${rowsWarning(rows)}${rows.filled}/${ASSET_COUNT} proxy rows, zoom ${zoom} ${nav}`.trim();
    },
  },
  {
    name: '12-explorer',
    file: stillPath('12-explorer'),
    async run(page) {
      const nav = await open(page, EXPLORER_URL, { waitUntil: 'load', zoom: 1 });
      const ok = await waitForText(page, new RegExp(TWO_CLOCKS), 20_000);
      const wall = await page.evaluate(() => /Just a moment|Verify you are human|Checking your browser|Access denied|Attention Required/i.test(document.body.innerText));
      if (!ok || wall) return `SKIP: stellar.expert ${wall ? 'showed a bot wall' : 'did not render the contract page'} for headless Chrome ${nav}`.trim();
      // The history list loads after the summary; give it a moment.
      await page.waitForNetworkIdle({ idleTime: 1500, timeout: 20_000 }).catch(() => undefined);
      await sleep(2000);
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
      // Load first: the ten rows take a while on the testnet RPC. The clip is the scroll over the filled board.
      await open(page, `${BASE}/`);
      const rows = await waitForRows(page);
      const r = await sectionRect(page, 'Board');
      if (!r) throw new Error('Board section not found');
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(300);
      const room = await scrollRoom(page);
      const distance = Math.min(room, Math.max(300, r.bottom + 40 - H));
      const took = await record(page, this.file, async () => {
        await sleep(1500);
        await slowScroll(page, distance, 9000);
        await sleep(2000);
      });
      return `${rowsWarning(rows)}scrolled ${Math.round(distance)}px, ${took}`;
    },
  },
  {
    name: 'clip-b-verify',
    file: clipPath('clip-b-verify'),
    async run(page) {
      // Zoom 1.4: the card grows by one notice once a result shows and still fits the frame.
      await open(page, `${BASE}/`, { zoom: 1.4 });
      const rows = await waitForRows(page);
      await showSection(page, 'Verify a report');
      let ok = false;
      let tampered = false;
      const took = await record(page, this.file, async () => {
        await sleep(1200);
        await clickButton(page, 'Verify by simulation');
        ok = await waitForText(page, VERIFY_OK);
        await sleep(3000);
        await clickButton(page, 'Flip byte 479 and verify');
        tampered = await waitForText(page, VERIFY_TAMPERED);
        await sleep(3000);
      });
      const warn = `${ok ? '' : 'WARN: no verify result; '}${tampered ? '' : 'WARN: no #12; '}`;
      return `${warn}${rowsWarning(rows)}${took}`;
    },
  },
  {
    name: 'clip-c-refresh',
    file: clipPath('clip-c-refresh'),
    async run(page) {
      const lines = trimBlanks(readLines(REFRESH_LOG));
      const highlight = /stored 10 of 10/;
      const title = logTitle(REFRESH_LOG, 'pnpm refresh --network testnet');
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
      // The board above grows by ten rows once the simulations answer; measure after that, not before.
      const rows = await waitForRows(page);
      const ok = await waitForText(page, /Two clocks\./, 30_000);
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
      return `${ok ? '' : 'WARN: section text not shown; '}${rowsWarning(rows)}scrolled ${Math.round(distance)}px, ${took}`;
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
      console.log(`${status}  ${shot.name.padEnd(18)} ${rel(shot.file).padEnd(64)} ${size.padStart(8)} ${secs.padStart(7)}  ${note}`);
    } catch (e) {
      tally.fail += 1;
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      console.log(`FAIL  ${shot.name.padEnd(18)} ${msg}`);
    } finally {
      if (page) await page.close().catch(() => undefined);
    }
  }
} finally {
  await browser.close();
}
console.log(`${tally.ok} ok, ${tally.warn} partial, ${tally.skip} skipped, ${tally.fail} failed`);
process.exit(tally.fail ? 1 : 0);
