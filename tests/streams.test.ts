// The Data Streams client against a stubbed fetch: the HMAC vector, the headers
// every call carries, the error bodies that come back as replies, and the
// exact candle parsing against the float that JSON.parse produces.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CANDLESTICK_API,
  EMPTY_BODY_SHA256,
  STREAMS_API,
  USERNAME_REDACTION,
  USER_AGENT,
  authorize,
  bodySha256,
  bulkReports,
  describeReply,
  discovery,
  exactCandles,
  expandExponent,
  feedsList,
  historyRows,
  hmacHeaders,
  jsonLossy,
  latestReport,
  literalToE18,
  lossyCandles,
  parseExact,
  quoteNumbers,
  redactSecrets,
  registerSecret,
  shortBody,
  signingString,
  streamsGet,
  symbolInfo,
  usernameHint,
} from '../scripts/lib/streams.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Handler = (call: Call, index: number) => Response | Promise<Response>;

/** Replace global fetch for one test and record every call. */
function stubFetch(handler: Handler): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const CREDS = { username: '11111111-2222-3333-4444-555555555555', secret: 'test-secret' };
const XLM_TESTNET = '0x00037dfe3b67b7552cf15e10ee5fb0c0ab6d658b20eb558effe2ae4579d24c58';
const PATH = `/api/v1/reports/latest?feedID=${XLM_TESTNET}`;
const TS = 1762800000000;
// HMAC-SHA256("test-secret", "GET <PATH> <sha256('')> <username> 1762800000000"), computed with node:crypto by hand.
const EXPECTED_HMAC = '90ffb8b721ff52fd1c4c61f837ab31a6769976f91e1c37ccd663f924a03671e3';

describe('HMAC', () => {
  it('hashes the body with sha256, the empty body as sha256("")', () => {
    expect(bodySha256('')).toBe(EMPTY_BODY_SHA256);
    expect(EMPTY_BODY_SHA256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(bodySha256('{"a":1}')).toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });

  it('builds "METHOD PATH BODYHASH USERNAME TIMESTAMP" with the method upper-cased', () => {
    expect(signingString('get', PATH, EMPTY_BODY_SHA256, CREDS.username, TS)).toBe(
      `GET ${PATH} ${EMPTY_BODY_SHA256} ${CREDS.username} ${TS}`,
    );
  });

  it('matches the hand-computed vector and sets the four headers', () => {
    const headers = hmacHeaders(CREDS, 'GET', PATH, '', TS);
    expect(headers).toEqual({
      Authorization: CREDS.username,
      'X-Authorization-Timestamp': '1762800000000',
      'X-Authorization-Signature-SHA256': EXPECTED_HMAC,
      'User-Agent': USER_AGENT,
    });
  });

  it('changes with the secret, the path, the body and the timestamp', () => {
    const base = hmacHeaders(CREDS, 'GET', PATH, '', TS)['X-Authorization-Signature-SHA256'];
    expect(hmacHeaders({ ...CREDS, secret: 'other' }, 'GET', PATH, '', TS)['X-Authorization-Signature-SHA256']).not.toBe(base);
    expect(hmacHeaders(CREDS, 'GET', '/api/v1/feeds', '', TS)['X-Authorization-Signature-SHA256']).not.toBe(base);
    expect(hmacHeaders(CREDS, 'GET', PATH, '{}', TS)['X-Authorization-Signature-SHA256']).not.toBe(base);
    expect(hmacHeaders(CREDS, 'GET', PATH, '', TS + 1)['X-Authorization-Signature-SHA256']).not.toBe(base);
  });

  it('never puts the secret in a header', () => {
    expect(JSON.stringify(hmacHeaders(CREDS, 'GET', PATH, '', TS))).not.toContain(CREDS.secret);
  });

  it('usernameHint gives the length and no character of the username', () => {
    expect(usernameHint(CREDS.username)).toBe('36 characters, not logged');
    expect(usernameHint(CREDS.username)).not.toContain('1111');
  });
});

describe('streamsGet', () => {
  it('sends the HMAC headers and the User-Agent to the environment host', async () => {
    const calls = stubFetch(() => new Response('{"feeds":[]}', { status: 200 }));
    const reply = await feedsList('mainnet', CREDS);
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{"feeds":[]}');
    expect(reply.url).toBe(`${STREAMS_API.mainnet}/api/v1/feeds`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['Authorization']).toBe(CREDS.username);
    expect(calls[0]?.headers['User-Agent']).toBe(USER_AGENT);
    expect(calls[0]?.headers['X-Authorization-Signature-SHA256']).toMatch(/^[0-9a-f]{64}$/);
    const ts = Number(calls[0]?.headers['X-Authorization-Timestamp']);
    expect(Math.abs(ts - Date.now())).toBeLessThan(5_000);
  });

  it('keyless discovery sends no Authorization, and userAgent false sends an empty User-Agent', async () => {
    const calls = stubFetch(() => new Response('{"feeds":[]}', { status: 200 }));
    await discovery('testnet');
    await discovery('testnet', { userAgent: false });
    expect(calls[0]?.url).toBe(`${STREAMS_API.testnet}/api/v1/discovery`);
    expect(calls[0]?.headers['Authorization']).toBeUndefined();
    expect(calls[0]?.headers['User-Agent']).toBe(USER_AGENT);
    expect(calls[1]?.headers['User-Agent']).toBe('');
  });

  it.each([
    [401, '{"error":"user does not exist"}'],
    [404, '{"message":"report not found"}'],
    [429, 'rate limited'],
    [403, 'error code: 1010'],
  ])('returns HTTP %i with its body instead of throwing', async (status, body) => {
    stubFetch(() => new Response(body, { status, headers: { 'x-ratelimit-limit': '200', 'content-type': 'text/plain' } }));
    const reply = await latestReport('testnet', CREDS, XLM_TESTNET);
    expect(reply.status).toBe(status);
    expect(reply.body).toBe(body);
    expect(reply.rateLimit).toEqual({ 'x-ratelimit-limit': '200' });
    expect(describeReply(reply)).toContain(`HTTP ${status}`);
    expect(describeReply(reply)).toContain(body);
    expect(describeReply(reply)).toContain('x-ratelimit-limit: 200');
  });

  it('signs the path together with its query string', async () => {
    const calls = stubFetch(() => new Response('{}', { status: 200 }));
    await bulkReports('mainnet', CREDS, ['0xa', '0xb'], 1762800000);
    const pathWithQuery = '/api/v1/reports/bulk?feedIDs=0xa,0xb&timestamp=1762800000';
    expect(calls[0]?.url).toBe(`${STREAMS_API.mainnet}${pathWithQuery}`);
    const ts = Number(calls[0]?.headers['X-Authorization-Timestamp']);
    const expected = hmacHeaders(CREDS, 'GET', pathWithQuery, '', ts)['X-Authorization-Signature-SHA256'];
    expect(calls[0]?.headers['X-Authorization-Signature-SHA256']).toBe(expected);
  });

  it('streamsGet takes any path and a null auth', async () => {
    const calls = stubFetch(() => new Response('', { status: 400 }));
    const reply = await streamsGet('mainnet', '/api/v1/reports/page?feedID=0xa&startTimestamp=1&limit=2', { auth: null });
    expect(reply.status).toBe(400);
    expect(calls[0]?.headers['Authorization']).toBeUndefined();
    expect(describeReply(reply)).toContain('(empty body)');
  });

  it('shortBody collapses whitespace and caps the length', () => {
    expect(shortBody('  a \n b  ')).toBe('a b');
    expect(shortBody('')).toBe('(empty body)');
    const short = shortBody('x'.repeat(1000));
    expect(short.startsWith('x'.repeat(300))).toBe(true);
    expect(short).toContain('(1000 chars)');
  });

  it('shortBody and describeReply blank out registered secrets, such as the username an error body echoes', () => {
    registerSecret(CREDS.username, USERNAME_REDACTION);
    registerSecret(CREDS.secret);
    const body = `{"s":"error","errmsg":"Not found - user not found for id ${CREDS.username}"}`;
    expect(redactSecrets(body)).toContain('for id [username]');
    expect(shortBody(body)).not.toContain(CREDS.username);
    expect(shortBody(`secret=${CREDS.secret}`)).toBe('secret=[redacted]');
    const reply = { url: 'u', status: 404, statusText: 'Not Found', body, ms: 1, rateLimit: {} };
    expect(describeReply(reply)).not.toContain(CREDS.username);
    expect(describeReply(reply)).not.toContain('11111111');
    expect(describeReply(reply)).toContain('[username]');
  });

  it('authorize registers the token, so a later body log cannot leak it', async () => {
    stubFetch(() => new Response('{"s":"ok","d":{"access_token":"jwt.secret.token","expiration":1}}', { status: 200 }));
    const reply = await authorize('mainnet', 'user', 'pw');
    expect(reply.token).toBe('jwt.secret.token');
    expect(shortBody(reply.body)).toContain('[token]');
    expect(shortBody(reply.body)).not.toContain('jwt.secret.token');
  });
});

describe('candlestick', () => {
  it('authorize posts the login form and reads the token and expiry', async () => {
    const calls = stubFetch(() => new Response('{"s":"ok","d":{"access_token":"jwt.token.here","expiration":1762886400}}', { status: 200 }));
    const reply = await authorize('mainnet', 'user', 'pw');
    expect(calls[0]?.url).toBe(`${CANDLESTICK_API.mainnet}/api/v1/authorize`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe('login=user&password=pw');
    expect(calls[0]?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0]?.headers['User-Agent']).toBe(USER_AGENT);
    expect(reply.token).toBe('jwt.token.here');
    expect(reply.expiration).toBe(1762886400);
  });

  it('authorize on testnet with a 404 has no token and keeps the body', async () => {
    stubFetch(() => new Response('{"s":"error","errmsg":"user not found"}', { status: 404 }));
    const reply = await authorize('testnet', 'user', 'pw');
    expect(reply.status).toBe(404);
    expect(reply.token).toBeUndefined();
    expect(reply.body).toContain('user not found');
  });

  it('symbolInfo sends the bearer token and reads the symbol list', async () => {
    const calls = stubFetch(() => new Response('{"s":"ok","symbol":["XLMUSD","ETHUSD"],"description":["Stellar","Ethereum"]}', { status: 200 }));
    const reply = await symbolInfo('mainnet', 'jwt', 'crypto');
    expect(calls[0]?.url).toBe(`${CANDLESTICK_API.mainnet}/api/v1/symbol_info?group=crypto`);
    expect(calls[0]?.headers['Authorization']).toBe('Bearer jwt');
    expect(reply.symbols).toEqual(['XLMUSD', 'ETHUSD']);
  });

  it('historyRows keeps every digit while JSON.parse loses them', async () => {
    const body =
      '{"s":"ok","candles":[[1762797600,2123703115446831300000,2.1237031154468313e+21,2120000000000000000000,2123703115446831312345,0],[1762794000,147087870178380500,147087870178380500,147087870178380500,147087870178380500,1]]}';
    const calls = stubFetch(() => new Response(body, { status: 200 }));
    const reply = await historyRows('mainnet', 'jwt', { symbol: 'ETHUSD', resolution: '1h', from: 1, to: 2 });
    expect(calls[0]?.url).toBe(`${CANDLESTICK_API.mainnet}/api/v1/history/rows?symbol=ETHUSD&resolution=1h&from=1&to=2`);
    expect(reply.candles).toHaveLength(2);
    expect(reply.candles?.[0]).toEqual({
      t: '1762797600',
      o: '2123703115446831300000',
      h: '2.1237031154468313e+21',
      l: '2120000000000000000000',
      c: '2123703115446831312345',
      v: '0',
    });
    expect(literalToE18('2123703115446831312345')).toBe('2,123.703115');
    expect(literalToE18(reply.candles?.[0]?.h ?? '')).toBe('2,123.703115');
    const lossy = lossyCandles(body);
    expect(String(lossy[0]?.[4])).toBe('2.1237031154468313e+21');
    expect(String(lossy[0]?.[4])).not.toBe('2123703115446831312345');
    expect(reply.candles?.[1]?.c).toBe('147087870178380500');
    expect(Number.isSafeInteger(lossy[1]?.[4] ?? Number.NaN)).toBe(false);
  });

  it('historyRows leaves candles unset on a non-200 answer', async () => {
    stubFetch(() => new Response('{"s":"error","errmsg":"unauthorized"}', { status: 401 }));
    const reply = await historyRows('mainnet', 'bad', { symbol: 'ETHUSD', resolution: '1h', from: 1, to: 2 });
    expect(reply.status).toBe(401);
    expect(reply.candles).toBeUndefined();
  });
});

describe('exact numbers', () => {
  it('quoteNumbers quotes bare literals and leaves strings, booleans and null alone', () => {
    expect(quoteNumbers('{"s":"ok","n":12,"t":"a1b2 -3","e":1.5e3,"neg":-7,"b":true,"z":null}')).toBe(
      '{"s":"ok","n":"12","t":"a1b2 -3","e":"1.5e3","neg":"-7","b":true,"z":null}',
    );
    expect(parseExact('[1, 2.5, "x"]')).toEqual(['1', '2.5', 'x']);
    expect(jsonLossy('[1, 2.5, "x"]')).toEqual([1, 2.5, 'x']);
  });

  it('expandExponent writes the literal without an exponent', () => {
    expect(expandExponent('2.1237031154468313e+21')).toBe('2123703115446831300000');
    expect(expandExponent('147087870178380500')).toBe('147087870178380500');
    expect(expandExponent('1.5e-3')).toBe('0.0015');
    expect(expandExponent('-2e2')).toBe('-200');
    expect(expandExponent('1.50')).toBe('1.5');
    expect(expandExponent('0')).toBe('0');
    expect(() => expandExponent('abc')).toThrow(/not a numeric literal/);
  });

  it('literalToE18 formats integers and flags fractions', () => {
    expect(literalToE18('147087870178380500')).toBe('0.147087');
    expect(literalToE18('2.1237031154468313e+21')).toBe('2,123.703115');
    expect(literalToE18('1.5')).toContain('not an integer');
  });

  it('exactCandles rejects a body without candles', () => {
    expect(() => exactCandles('{"s":"no_data"}')).toThrow(/no candles array/);
    expect(() => exactCandles('{"candles":[[1,2]]}')).toThrow(/not \[t,o,h,l,c,v\]/);
  });
});
