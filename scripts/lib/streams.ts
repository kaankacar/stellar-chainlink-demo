// Chainlink Data Streams REST API (HMAC) and the Candlestick API (JWT).
// Every call sends a browser-like User-Agent: without one Cloudflare answers
// 403 "error code: 1010". The GET helpers return status and body and never
// throw on an HTTP error, so a 401 or a 404 can be logged as evidence.
import { createHash, createHmac } from 'node:crypto';
import type { NetworkName } from '../../src/lib/feeds.ts';
import { formatE18 } from '../../src/lib/report.ts';

/** A Data Streams environment. Credentials are per environment. */
export type StreamsEnv = NetworkName;

export const STREAMS_API: Readonly<Record<StreamsEnv, string>> = {
  testnet: 'https://api.testnet-dataengine.chain.link',
  mainnet: 'https://api.dataengine.chain.link',
};

export const CANDLESTICK_API: Readonly<Record<StreamsEnv, string>> = {
  testnet: 'https://priceapi.testnet-dataengine.chain.link',
  mainnet: 'https://priceapi.dataengine.chain.link',
};

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const DEFAULT_TIMEOUT_MS = 20_000;

// ---- Credentials ------------------------------------------------------------

export interface StreamsCredentials {
  /** The API key, a UUID. No part of it reaches a log. */
  username: string;
  secret: string;
}

/** Values that must never reach a log, with the text that replaces them. */
const redactions = new Map<string, string>();

/** Register a value so shortBody and describeReply blank it out. */
export function registerSecret(value: string, replacement = '[redacted]'): void {
  if (value.length >= 4) redactions.set(value, replacement);
}

/** Replace every registered secret in `text`. API bodies echo the username on some errors. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [value, replacement] of redactions) out = out.split(value).join(replacement);
  return out;
}

/** What a log may say about the username: its length, never its characters. */
export function usernameHint(username: string): string {
  return `${username.length} characters, not logged`;
}

/** The text that replaces the username wherever an API body echoes it. */
export const USERNAME_REDACTION = '[username]';

/** DATA_STREAMS_USERNAME and DATA_STREAMS_SECRET from process.env, or undefined when either is empty. */
export function credentialsFromEnv(): StreamsCredentials | undefined {
  const username = process.env['DATA_STREAMS_USERNAME']?.trim();
  const secret = process.env['DATA_STREAMS_SECRET']?.trim();
  if (!username || !secret) return undefined;
  registerSecret(username, USERNAME_REDACTION);
  registerSecret(secret);
  return { username, secret };
}

/** CANDLESTICK_API_KEY from process.env, or undefined. */
export function candlestickKeyFromEnv(): string | undefined {
  const key = process.env['CANDLESTICK_API_KEY']?.trim();
  if (!key) return undefined;
  registerSecret(key);
  return key;
}

// ---- HMAC -------------------------------------------------------------------

export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function bodySha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** "METHOD PATH_WITH_QUERY SHA256HEX(body) USERNAME TIMESTAMP_MS", the string the HMAC signs. */
export function signingString(
  method: string,
  pathWithQuery: string,
  bodyHashHex: string,
  username: string,
  timestampMs: number,
): string {
  return `${method.toUpperCase()} ${pathWithQuery} ${bodyHashHex} ${username} ${timestampMs}`;
}

export function hmacSignature(secret: string, toSign: string): string {
  return createHmac('sha256', secret).update(toSign).digest('hex');
}

/** The four headers every authenticated Data Streams call carries. */
export function hmacHeaders(
  creds: StreamsCredentials,
  method: string,
  pathWithQuery: string,
  body = '',
  timestampMs: number = Date.now(),
): Record<string, string> {
  const toSign = signingString(method, pathWithQuery, bodySha256(body), creds.username, timestampMs);
  return {
    Authorization: creds.username,
    'X-Authorization-Timestamp': String(timestampMs),
    'X-Authorization-Signature-SHA256': hmacSignature(creds.secret, toSign),
    'User-Agent': USER_AGENT,
  };
}

// ---- HTTP -------------------------------------------------------------------

export interface ApiReply {
  url: string;
  status: number;
  statusText: string;
  body: string;
  ms: number;
  /** Every response header whose name contains "ratelimit", lower-cased. */
  rateLimit: Record<string, string>;
}

export interface GetOptions {
  /** HMAC credentials. Omit or null for a keyless call. */
  auth?: StreamsCredentials | null;
  /**
   * Send the browser-like User-Agent. Default true. False sends an empty
   * User-Agent (Node would otherwise send "node"), the case Cloudflare refused
   * with error code 1010 on 9 November.
   */
  userAgent?: boolean;
  timeoutMs?: number;
}

function rateLimitHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase().includes('ratelimit')) out[name.toLowerCase()] = value;
  });
  return out;
}

async function getUrl(url: string, headers: Record<string, string>, timeoutMs: number): Promise<ApiReply> {
  const started = performance.now();
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  return {
    url,
    status: response.status,
    statusText: response.statusText,
    body,
    ms: performance.now() - started,
    rateLimit: rateLimitHeaders(response.headers),
  };
}

/** GET a Data Streams path such as "/api/v1/feeds". HTTP errors come back as a reply, not a throw. */
export function streamsGet(env: StreamsEnv, pathWithQuery: string, opts: GetOptions = {}): Promise<ApiReply> {
  const headers: Record<string, string> = opts.auth ? hmacHeaders(opts.auth, 'GET', pathWithQuery) : {};
  headers['User-Agent'] = opts.userAgent === false ? '' : USER_AGENT;
  headers['Accept'] = 'application/json';
  return getUrl(`${STREAMS_API[env]}${pathWithQuery}`, headers, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/** The keyless catalog of streams. */
export function discovery(env: StreamsEnv, opts: GetOptions = {}): Promise<ApiReply> {
  return streamsGet(env, '/api/v1/discovery', opts);
}

/** The streams this account may read. */
export function feedsList(env: StreamsEnv, auth: StreamsCredentials): Promise<ApiReply> {
  return streamsGet(env, '/api/v1/feeds', { auth });
}

/** The latest signed report for one stream id (0x-prefixed). */
export function latestReport(env: StreamsEnv, auth: StreamsCredentials, feedId: string): Promise<ApiReply> {
  return streamsGet(env, `/api/v1/reports/latest?feedID=${feedId}`, { auth });
}

/** Signed reports for several streams at one unix-second timestamp. */
export function bulkReports(
  env: StreamsEnv,
  auth: StreamsCredentials,
  feedIds: readonly string[],
  timestampSec: number,
): Promise<ApiReply> {
  return streamsGet(env, `/api/v1/reports/bulk?feedIDs=${feedIds.join(',')}&timestamp=${timestampSec}`, { auth });
}

/** One line, at most `max` characters, with every registered secret blanked out. For logs. */
export function shortBody(text: string, max = 300): string {
  const oneLine = redactSecrets(text).replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return '(empty body)';
  return oneLine.length > max ? `${oneLine.slice(0, max)}... (${oneLine.length} chars)` : oneLine;
}

/** The parsed JSON body, or undefined when it is not JSON. */
export function jsonOf(reply: Pick<ApiReply, 'body'>): unknown {
  try {
    return JSON.parse(reply.body) as unknown;
  } catch {
    return undefined;
  }
}

/** "HTTP 404 Not Found in 312 ms, body: {...}" plus the rate-limit headers when present. */
export function describeReply(reply: ApiReply): string {
  const limits = Object.entries(reply.rateLimit)
    .map(([name, value]) => `${name}: ${value}`)
    .join(', ');
  const head = `HTTP ${reply.status} ${reply.statusText} in ${Math.round(reply.ms)} ms, body: ${shortBody(reply.body)}`;
  return limits ? `${head} [${limits}]` : head;
}

// ---- Candlestick API --------------------------------------------------------

export interface AuthorizeReply extends ApiReply {
  token?: string;
  /** Unix seconds. */
  expiration?: number;
}

/** POST /api/v1/authorize with the form login and password. The password is the candlestick key, never logged. */
export async function authorize(env: StreamsEnv, username: string, password: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AuthorizeReply> {
  const url = `${CANDLESTICK_API[env]}/api/v1/authorize`;
  const form = new URLSearchParams({ login: username, password });
  const started = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  const reply: AuthorizeReply = {
    url,
    status: response.status,
    statusText: response.statusText,
    body,
    ms: performance.now() - started,
    rateLimit: rateLimitHeaders(response.headers),
  };
  const json = jsonOf(reply) as { s?: string; d?: { access_token?: string; expiration?: number } } | undefined;
  if (json?.s === 'ok' && typeof json.d?.access_token === 'string') {
    reply.token = json.d.access_token;
    registerSecret(reply.token, '[token]');
    if (typeof json.d.expiration === 'number') reply.expiration = json.d.expiration;
  }
  return reply;
}

function bearerGet(env: StreamsEnv, pathWithQuery: string, token: string, timeoutMs: number): Promise<ApiReply> {
  return getUrl(
    `${CANDLESTICK_API[env]}${pathWithQuery}`,
    { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT, Accept: 'application/json' },
    timeoutMs,
  );
}

export interface SymbolInfoReply extends ApiReply {
  /** The `symbol` list of the body, for example ["XLMUSD", "ETHUSD"]. */
  symbols?: string[];
}

/** GET /api/v1/symbol_info[?group=crypto]. */
export async function symbolInfo(env: StreamsEnv, token: string, group?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SymbolInfoReply> {
  const path = group ? `/api/v1/symbol_info?group=${encodeURIComponent(group)}` : '/api/v1/symbol_info';
  const reply: SymbolInfoReply = await bearerGet(env, path, token, timeoutMs);
  const json = jsonOf(reply) as { symbol?: unknown } | undefined;
  if (Array.isArray(json?.symbol)) reply.symbols = json.symbol.filter((s): s is string => typeof s === 'string');
  return reply;
}

/** One candle with every value kept as the literal text of the response. */
export interface ExactCandle {
  t: string;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

export interface HistoryRowsReply extends ApiReply {
  /** Newest first, as the API sends them. Only set when the body parsed. */
  candles?: ExactCandle[];
}

export interface HistoryQuery {
  /** For example "ETHUSD". */
  symbol: string;
  /** For example "1h". */
  resolution: string;
  /** Unix seconds. */
  from: number;
  to: number;
}

/** GET /api/v1/history/rows. Values are 18-decimal integers; the exact parse keeps every digit. */
export async function historyRows(env: StreamsEnv, token: string, query: HistoryQuery, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HistoryRowsReply> {
  const path = `/api/v1/history/rows?symbol=${encodeURIComponent(query.symbol)}&resolution=${encodeURIComponent(query.resolution)}&from=${query.from}&to=${query.to}`;
  const reply: HistoryRowsReply = await bearerGet(env, path, token, timeoutMs);
  if (reply.status === 200) {
    try {
      reply.candles = exactCandles(reply.body);
    } catch {
      reply.candles = undefined;
    }
  }
  return reply;
}

// ---- Exact numbers ----------------------------------------------------------

// A JSON string, or a bare numeric literal outside a string. The string branch
// comes first, so digits inside strings are left alone.
const STRING_OR_NUMBER = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Wrap every bare numeric literal in quotes, so JSON.parse keeps its digits. */
export function quoteNumbers(text: string): string {
  return text.replace(STRING_OR_NUMBER, (match) => (match.startsWith('"') ? match : `"${match}"`));
}

/** JSON.parse with every number delivered as its literal text. */
export function parseExact(text: string): unknown {
  return JSON.parse(quoteNumbers(text)) as unknown;
}

/** Plain JSON.parse: numbers above 2^53 and long decimals lose digits here. */
export function jsonLossy(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** "2.1237031154468313e+21" as "2123703115446831300000": the literal without an exponent. */
export function expandExponent(literal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal.trim());
  if (!match) throw new Error(`not a numeric literal: ${literal}`);
  const sign = match[1] ?? '';
  const whole = match[2] ?? '0';
  const frac = match[3] ?? '';
  const exponent = Number(match[4] ?? '0');
  const digits = whole + frac;
  const point = whole.length + exponent;
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  out = out.replace(/^0+(?=\d)/, '');
  if (out.includes('.')) out = out.replace(/\.?0+$/, '');
  return `${sign}${out}`;
}

/** An 18-decimal literal as a price string, or the expanded literal when it is not an integer. */
export function literalToE18(literal: string, fractionDigits = 6): string {
  const plain = expandExponent(literal);
  if (plain.includes('.')) return `${plain} (not an integer)`;
  return formatE18(BigInt(plain), fractionDigits);
}

const CANDLE_FIELDS = ['t', 'o', 'h', 'l', 'c', 'v'] as const;

/** The `candles` rows of a history/rows body, every value as literal text. */
export function exactCandles(text: string): ExactCandle[] {
  const parsed = parseExact(text) as { s?: string; candles?: unknown };
  if (!Array.isArray(parsed.candles)) throw new Error(`no candles array in the body (s=${String(parsed.s)})`);
  return parsed.candles.map((row, index) => {
    if (!Array.isArray(row) || row.length < 6) throw new Error(`candle ${index} is not [t,o,h,l,c,v]`);
    const candle: Record<string, string> = {};
    CANDLE_FIELDS.forEach((field, i) => {
      candle[field] = String(row[i]);
    });
    return candle as unknown as ExactCandle;
  });
}

/** The same rows through plain JSON.parse, for the comparison. */
export function lossyCandles(text: string): number[][] {
  const parsed = jsonLossy(text) as { candles?: unknown };
  if (!Array.isArray(parsed.candles)) throw new Error('no candles array in the body');
  return parsed.candles.map((row) => (Array.isArray(row) ? row.map((v) => Number(v)) : []));
}
