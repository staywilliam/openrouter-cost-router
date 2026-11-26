import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { endpointModel, pinnedProvider, rankEndpoints, responseUsage, RoutingError } from './routing.mjs';

const UPSTREAM = 'https://openrouter.ai/api/v1/';
const PRICING_TTL_MS = 60_000;
const OMIT_HEADERS = [
  'connection', 'content-encoding', 'content-length', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
];

function errorResponse(status, message) {
  return Response.json({ error: { code: status, message } }, { status });
}

function outgoingHeaders(incoming, apiKey) {
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'http-referer', 'x-openrouter-title', 'x-title',
    'x-session-id', 'user-agent', 'anthropic-beta']) {
    if (incoming.has(name)) headers.set(name, incoming.get(name));
  }
  headers.set('authorization', `Bearer ${apiKey}`);
  return headers;
}

function downstreamResponse(upstream, body = upstream.body) {
  const headers = new Headers(upstream.headers);
  for (const name of OMIT_HEADERS) headers.delete(name);
  return new Response(body, { status: upstream.status, headers });
}

function observeSse(stream, record) {
  const decoder = new TextDecoder();
  let pending = '';
  const inspect = frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data.includes('response.completed') && !data.includes('response.incomplete')
      && !/^event: response\.(completed|incomplete)/m.test(frame)) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.response) record(event.response);
  };
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop();
      for (const frame of frames) inspect(frame);
    },
    flush() { inspect(pending + decoder.decode()); },
  }));
}

async function observedResponse(upstream, record) {
  if (!upstream.ok || !upstream.body) return downstreamResponse(upstream);
  if ((upstream.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return downstreamResponse(upstream, observeSse(upstream.body, record));
  }
  const body = await upstream.arrayBuffer();
  let response;
  try { response = JSON.parse(new TextDecoder().decode(body)); } catch { /* Forward the original bytes. */ }
  if (response) record(response);
  return downstreamResponse(upstream, body);
}

function actualEndpoint(winner, response, endpoints) {
  if (winner.tier && ['default', 'standard'].includes(response.service_tier)) {
    const regular = winner.tag.replace(/\/(?:flex|priority|fast|turbo|ultrafast)$/, '');
    return endpoints.some(endpoint => endpoint.tag === regular) ? regular : winner.tag;
  }
  return winner.tag;
}

async function unavailable(response) {
  if (response.status === 429) return true;
  if (response.status !== 404) return false;
  // A 404 for missing credentials, a missing model, or a bad continuation
  // should reach the caller. Retry only when routing found no eligible endpoint.
  const error = await response.clone().json().catch(() => null);
  return /\bno (?:endpoints?|allowed providers are available)\b/i.test(error?.error?.message ?? '');
}

export function createGateway({ apiKey, history, options = {}, fetcher = fetch, clock = Date.now }) {
  const pricingCache = new Map();
  let lastDecision = null;

  async function endpointsFor(model) {
    const now = clock();
    const existing = pricingCache.get(model);
    if (existing && existing.expires > now) return existing.promise;
    const path = model.split('/').map(encodeURIComponent).join('/');
    const promise = (async () => {
      const response = await fetcher(new URL(`models/${path}/endpoints`, UPSTREAM), {
        headers: { authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status === 404 ? 422 : 502;
        throw new RoutingError(`OpenRouter could not return endpoint prices for ${model} (HTTP ${response.status}).`, status);
      }
      const data = (await response.json()).data;
      if (!Array.isArray(data?.endpoints)) throw new RoutingError('OpenRouter returned an invalid endpoint catalog.', 502);
      return data.endpoints.filter(endpoint => endpoint && typeof endpoint.tag === 'string');
    })();
    const entry = { expires: now + PRICING_TTL_MS, promise };
    pricingCache.set(model, entry);
    try { return await promise; }
    catch (error) {
      if (pricingCache.get(model) === entry) pricingCache.delete(model);
      throw error;
    }
  }

  async function routeResponse(request, query) {
    const body = await request.json().catch(() => { throw new RoutingError('Expected a JSON Responses request.', 400); });
    const model = endpointModel(body);
    const provider = body.provider;
    if (provider !== undefined && provider !== null && (typeof provider !== 'object' || Array.isArray(provider)
      || ['ignore', 'only', 'order'].some(key => provider[key] != null && !Array.isArray(provider[key])))) {
      throw new RoutingError('Expected provider preferences with array values for only, ignore, and order.', 400);
    }
    const endpoints = await endpointsFor(model);
    const now = clock();
    const session = body.session_id ?? request.headers.get('x-session-id') ?? body.prompt_cache_key;
    const sessionId = typeof session === 'string' && session ? session : undefined;
    const continuation = history.response(model, body.previous_response_id);
    if (body.previous_response_id && !continuation) {
      throw new RoutingError('This continuation has no known endpoint in the router history. Start a new Codex session or replay the input.');
    }
    const recent = history.recent(model, options.window ?? 40, now);
    const ranked = rankEndpoints({ endpoints, body, history: recent, session: history.session(model, sessionId),
      continuation, options, now: new Date(now) });
    if (!ranked.length) {
      throw new RoutingError(`No priced endpoint for ${model} can satisfy this request and the configured limits.`);
    }

    const maximum = ranked[0].estimatedUsd * (options.fallbackRatio ?? 1);
    const eligible = ranked.filter(candidate => candidate.estimatedUsd <= maximum + 1e-12);
    const lowestEstimates = ranked.slice(0, 5).map(({ tag, estimatedUsd }) => ({ endpoint: tag, estimatedUsd }));
    const target = new URL('responses', UPSTREAM);
    target.search = query;
    const headers = outgoingHeaders(request.headers, apiKey);
    headers.set('content-type', 'application/json');
    for (const [index, winner] of eligible.entries()) {
      const decision = {
        model, endpoint: winner.tag, estimatedUsd: winner.estimatedUsd,
        cacheReadPerMillion: winner.cacheReadPerMillion, estimatedTokens: winner.forecast,
        samples: recent.length, pricedEndpoints: ranked.length, lowestEstimates, attempts: index + 1,
      };
      lastDecision = decision;
      const upstream = await fetcher(target, {
        method: 'POST', redirect: 'error', headers, signal: request.signal,
        body: JSON.stringify({ ...body, provider: pinnedProvider(provider, winner.tag, endpoints) }),
      });
      decision.upstreamStatus = upstream.status;
      if (index + 1 < eligible.length && await unavailable(upstream)) {
        await upstream.body?.cancel();
        continue;
      }
      return observedResponse(upstream, response => {
        const usage = responseUsage(response);
        if (!usage) return;
        decision.billedTier = response.service_tier ?? null;
        decision.usageEndpoint = actualEndpoint(winner, response, endpoints);
        decision.actualTokens = usage;
        if (typeof response.usage.cost === 'number') decision.actualUsd = response.usage.cost;
        try {
          history.record({ model, endpoint: decision.usageEndpoint, session: sessionId,
            response: typeof response.id === 'string' ? response.id : undefined, recordedAt: clock(), usage });
        } catch (error) {
          decision.historyError = error.code ?? 'WRITE_FAILED';
        }
      });
    }
    throw new RoutingError(`OpenRouter had no available endpoint for ${model} within the allowed estimate.`, 503);
  }

  return async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ status: 'ok' });
    if (request.headers.get('authorization') !== `Bearer ${apiKey}`) {
      return errorResponse(401, 'Send the same OpenRouter API key configured for this local router.');
    }
    try {
      if (url.pathname === '/status' && request.method === 'GET') return Response.json({ lastDecision });
      if (url.pathname === '/v1/models' && request.method === 'GET') {
        const target = new URL('models', UPSTREAM);
        target.search = url.search;
        return downstreamResponse(await fetcher(target, { headers: outgoingHeaders(request.headers, apiKey),
          signal: request.signal, redirect: 'error' }));
      }
      if (url.pathname === '/v1/responses' && request.method === 'POST') return await routeResponse(request, url.search);
      return errorResponse(404, 'This gateway exposes GET /v1/models and POST /v1/responses.');
    } catch (error) {
      if (error instanceof RoutingError) return errorResponse(error.status, error.message);
      return errorResponse(502, 'The local router could not complete the OpenRouter request.');
    }
  };
}

export function httpServer(handle) {
  return createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    incoming.on('aborted', () => abort.abort());
    outgoing.on('close', () => { if (!outgoing.writableFinished) abort.abort(); });
    try {
      const method = incoming.method;
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method,
        headers: incoming.headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : Readable.toWeb(incoming),
        duplex: 'half',
        signal: abort.signal,
      });
      const result = await handle(request);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.fromWeb(result.body), outgoing);
      else outgoing.end();
    } catch {
      if (outgoing.destroyed) return;
      if (outgoing.headersSent) outgoing.destroy();
      else {
        outgoing.writeHead(502, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ error: { code: 502, message: 'Local gateway connection failed.' } }));
      }
    }
  });
}
