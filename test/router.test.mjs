import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGateway, httpServer } from '../plugins/openrouter-cost-router/gateway.mjs';
import { openHistory } from '../plugins/openrouter-cost-router/history.mjs';
import { pinnedProvider, rankEndpoints, responseUsage } from '../plugins/openrouter-cost-router/routing.mjs';

const MODEL = 'deepseek/deepseek-v4.1-flash-1017';
const KEY = 'openrouter-mock-api-key';
const BASE = 'http://127.0.0.1';
const AT = Date.UTC(2026, 10, 26, 9, 0);

function endpoint(tag, prompt, completion, cached, extra = {}) {
  return { tag, supported_parameters: ['tools'], pricing: {
    prompt: String(prompt / 1e6), completion: String(completion / 1e6),
    ...(cached === undefined ? {} : { input_cache_read: String(cached / 1e6) }),
  }, ...extra };
}

function local(path, body) {
  return new Request(BASE + path, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function usage(id, tier = 'default') {
  return { id, model: MODEL, status: 'completed', service_tier: tier,
    usage: { input_tokens: 100000, output_tokens: 100,
      input_tokens_details: { cached_tokens: 99000, cache_write_tokens: 500 },
      output_tokens_details: { reasoning_tokens: 15 } } };
}

const simple = [endpoint('tenstorrent', 0.03, 0.20, 0.001), endpoint('sail-research', 0.04, 0.10, 0.007)];

test('a cold-start route learns cache usage from an intact SSE stream and compares the next session', async t => {
  const history = openHistory(':memory:', 'fixture');
  t.after(() => history.close());
  const calls = [];
  let quoteReads = 0;
  let streamBytes;
  const gateway = createGateway({ apiKey: KEY, history, clock: () => AT, fetcher: async (url, init) => {
    if (url.pathname.endsWith('/endpoints')) {
      quoteReads++;
      return Response.json({ data: { endpoints: simple } });
    }
    const parsed = JSON.parse(init.body);
    calls.push(parsed);
    const event = JSON.stringify({ type: 'response.completed', response: usage(`gen-${calls.length}`) });
    streamBytes = `event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"测试"}\r\n\r\nevent: response.completed\ndata: ${event}\n\n`;
    const buffer = new TextEncoder().encode(streamBytes);
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < buffer.length; offset += 17) controller.enqueue(buffer.slice(offset, offset + 17));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' } });
  } });

  const request = { model: MODEL, input: 'hello', stream: true, prompt_cache_key: 'session-a',
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }], store: false };
  const first = await gateway(local('/v1/responses', request));
  assert.equal(first.headers.get('x-request-id'), 'fixture-request');
  assert.equal(await first.text(), streamBytes);
  assert.deepEqual(calls[0].provider.only, ['sail-research']);
  assert.equal(calls[0].provider.allow_fallbacks, false);
  assert.deepEqual(calls[0].tools, request.tools);
  assert.equal(calls[0].store, false);
  assert.equal(history.recent(MODEL, 40, AT)[0].cached, 99000);
  assert.equal(history.recent(MODEL, 40, AT)[0].writes, 500);

  const warm = await gateway(local('/v1/responses', request));
  await warm.text();
  assert.deepEqual(calls[1].provider.only, ['sail-research']);
  const another = await gateway(local('/v1/responses', { ...request, prompt_cache_key: 'session-b' }));
  await another.text();
  assert.deepEqual(calls[2].provider.only, ['tenstorrent']);
  assert.equal(quoteReads, 1);
  const status = await (await gateway(local('/status'))).json();
  assert.equal(status.lastDecision.actualTokens.reasoning, 15);
  assert.equal(status.lastDecision.samples, 2);
});

test('cache cap considers quoted length tiers and the default price of a Flex endpoint', () => {
  const longTier = endpoint('tiered', 0.01, 0.01, 0.0005);
  longTier.pricing.overrides = [{ min_prompt_tokens: 1000000, input_cache_read: '0.000000002' }];
  const endpoints = [...simple, longTier, endpoint('missing-cache', 0.001, 0.001),
    endpoint('flex-company', 0.02, 0.02, 0.02),
    endpoint('flex-company/flex', 0.01, 0.01, 0.0005, { service_tier: 'flex' })];
  const ranked = rankEndpoints({ endpoints, body: { model: MODEL, input: 'test' }, history: [],
    options: { maxCacheRead: 0.001 }, now: new Date(AT) });
  assert.deepEqual(ranked.map(row => row.tag), ['tenstorrent']);
});

test('ranking uses current discounts and time-window overrides and preserves a budget and provider exclusions', () => {
  const standard = endpoint('regular', 0.10, 0.10, 0.01);
  const timed = endpoint('timed', 1, 1, 0.01, { discount: 0.5 });
  timed.pricing.overrides = [{ utc_start: 800, utc_end: 1000, prompt: '0.00000008', completion: '0.00000008' }];
  const endpoints = [standard, timed, endpoint('wafer', 0.001, 0.001, 0.0001)];
  const body = { model: MODEL, input: 'abc', provider: { ignore: ['wafer'], max_price: { prompt: 0.1 } } };
  const evaluate = now => rankEndpoints({ endpoints, body, history: [], now }).map(row => row.tag);
  assert.deepEqual(evaluate(new Date(AT)), ['timed', 'regular']);
  assert.deepEqual(evaluate(new Date(AT + 3 * 60 * 60 * 1000)), ['regular']);
});

test('pinning a base tag excludes its catalog siblings and retains request policies', () => {
  const endpoints = ['a', 'a/us', 'a/flex', 'b'].map(tag => ({ tag }));
  assert.deepEqual(pinnedProvider({ ignore: ['wafer'], zdr: true, sort: 'price' }, 'a', endpoints), {
    only: ['a'], order: ['a'], ignore: ['wafer', 'a/us', 'a/flex'], zdr: true, allow_fallbacks: false,
  });
});

test('fallbacks are limited by the configured estimate ratio', async t => {
  const history = openHistory(':memory:', 'fixture');
  t.after(() => history.close());
  const endpoints = [endpoint('first', 0.01, 0.10), endpoint('second', 0.011, 0.11), endpoint('expensive', 1, 1)];
  const unavailableMessage = 'No allowed providers are available for the selected model. '
    + `Providers serving ${MODEL}: second, but your request's provider.only preference permits only: first.`;
  const attempts = [];
  const fetcher = async (url, init) => {
    if (url.pathname.endsWith('/endpoints')) return Response.json({ data: { endpoints } });
    const selected = JSON.parse(init.body).provider.only[0];
    attempts.push(selected);
    if (selected === 'first') return Response.json({ error: { message: unavailableMessage } }, { status: 404 });
    return Response.json(usage('gen-fallback'));
  };

  const request = { model: MODEL, input: 'hi' };
  const strict = createGateway({ apiKey: KEY, history, fetcher, clock: () => AT });
  const failed = await strict(local('/v1/responses', request));
  assert.equal(failed.status, 404);
  assert.deepEqual(attempts, ['first']);
  const tolerant = createGateway({ apiKey: KEY, history, fetcher, clock: () => AT, options: { fallbackRatio: 1.2 } });
  assert.equal((await tolerant(local('/v1/responses', request))).status, 200);
  assert.deepEqual(attempts, ['first', 'first', 'second']);
});

test('no cache-price match returns a local error without an inference request', async t => {
  const history = openHistory(':memory:', 'fixture');
  t.after(() => history.close());
  const upstream = [];
  const gateway = createGateway({ apiKey: KEY, history, options: { maxCacheRead: 0.0005 }, fetcher: async url => {
    upstream.push(url.pathname);
    return Response.json({ data: { endpoints: simple } });
  } });
  const response = await gateway(local('/v1/responses', { model: MODEL, input: 'hi' }));
  assert.equal(response.status, 422);
  assert.deepEqual(upstream, [`/api/v1/models/${MODEL}/endpoints`]);
});

test('a :floor model uses base-model prices and pins a known Responses continuation', async t => {
  const history = openHistory(':memory:', 'fixture');
  t.after(() => history.close());
  history.record({ model: MODEL, endpoint: 'sail-research', response: 'gen-prev',
    recordedAt: AT, usage: responseUsage(usage('gen-prev')) });
  const gateway = createGateway({ apiKey: KEY, history, clock: () => AT, fetcher: async (url, init) => {
    if (url.pathname.endsWith('/endpoints')) {
      assert.equal(url.pathname, `/api/v1/models/${MODEL}/endpoints`);
      return Response.json({ data: { endpoints: simple } });
    }
    const body = JSON.parse(init.body);
    assert.equal(body.model, `${MODEL}:floor`);
    assert.equal(body.previous_response_id, 'gen-prev');
    assert.deepEqual(body.provider.only, ['sail-research']);
    return Response.json(usage('gen-next'));
  } });
  const response = await gateway(local('/v1/responses', { model: `${MODEL}:floor`, input: 'next', previous_response_id: 'gen-prev' }));
  assert.equal(response.status, 200);
});

test('catalog keeps the Codex query parameter and masks the gateway from unauthenticated calls', async t => {
  const history = openHistory(':memory:', 'fixture');
  t.after(() => history.close());
  const catalog = { models: [{ slug: MODEL, display_name: 'DeepSeek V4.1 Flash' }] };
  let calls = 0;
  const gateway = createGateway({ apiKey: KEY, history, fetcher: async (url, init) => {
    calls++;
    assert.equal(url.href, 'https://openrouter.ai/api/v1/models?client_version=0.172.0');
    assert.equal(init.headers.get('authorization'), `Bearer ${KEY}`);
    return Response.json(catalog);
  } });
  const anonymous = await gateway(new Request(BASE + '/v1/models'));
  assert.equal(anonymous.status, 401);
  assert.equal(calls, 0);
  const response = await gateway(local('/v1/models?client_version=0.172.0'));
  assert.deepEqual(await response.json(), catalog);
});

test('recent history survives restart and deduplicates completed responses per API key', t => {
  const dir = mkdtempSync(join(tmpdir(), 'openrouter-router-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'usage.sqlite');
  const row = { model: MODEL, endpoint: 'tenstorrent', session: 'local-session',
    response: 'gen-1', recordedAt: Date.now(), usage: responseUsage(usage('gen-1')) };
  const history = openHistory(database, 'one');
  history.record(row);
  history.record(row);
  history.close();
  const reopened = openHistory(database, 'one');
  assert.equal(reopened.recent(MODEL, 40, Date.now()).length, 1);
  assert.equal(reopened.session(MODEL, 'local-session').endpoint, 'tenstorrent');
  assert.equal(reopened.response(MODEL, 'gen-1').output, 100);
  reopened.close();
  const second = openHistory(database, 'two');
  assert.deepEqual(second.recent(MODEL, 40, Date.now()), []);
  second.close();
});

test('real HTTP loopback delivers SSE data before the completed response',
  { skip: !process.env.OPENROUTER_TEST_LOOPBACK, timeout: 5000 }, async t => {
  const history = openHistory(':memory:', 'fixture');
  const delta = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"test"}\n\n';
  const completion = 'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: usage('gen-loopback') }) + '\n\n';
  const encoder = new TextEncoder();
  let finish;
  const gateway = createGateway({ apiKey: KEY, history, fetcher: async (url, init) => {
    if (url.pathname.endsWith('/endpoints')) return Response.json({ data: { endpoints: simple } });
    assert.deepEqual(JSON.parse(init.body).provider.only, ['sail-research']);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(delta));
      finish = () => { controller.enqueue(encoder.encode(completion)); controller.close(); };
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const server = httpServer(gateway);
  t.after(() => { server.close(); server.closeAllConnections(); history.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`${BASE}:${server.address().port}/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: 'hello', stream: true }),
  });
  assert.equal(response.status, 200);
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let received = '';
  while (received.length < delta.length) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    received += decoder.decode(value, { stream: true });
  }
  assert.equal(received, delta);
  finish();
  for (let result = await reader.read(); !result.done; result = await reader.read()) {
    received += decoder.decode(result.value, { stream: true });
  }
  assert.equal(received + decoder.decode(), delta + completion);
});
