const PER_MILLION = 1_000_000;
const MINUTE = 60_000;
const WARM_CACHE_MS = 5 * MINUTE;
const PRICE_FIELDS = [
  'prompt', 'completion', 'input_cache_read', 'input_cache_write', 'internal_reasoning', 'request', 'image',
];
const PRICE_OVERRIDE_KEYS = new Set([...PRICE_FIELDS, 'input_cache_write_1h', 'web_search', 'image_input', 'image_output',
  'audio', 'audio_input', 'audio_output', 'min_prompt_tokens', 'utc_start', 'utc_end', 'utc_days']);
const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

export class RoutingError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

export function endpointModel(body) {
  const model = body?.model;
  if (typeof model !== 'string' || !/^[\w.-]+\/[\w.:-]+$/.test(model)
    || model.startsWith('openrouter/') || Array.isArray(body.models) && body.models.length) {
    throw new RoutingError('Select a single OpenRouter model by its catalog ID, such as deepseek/deepseek-v4.1-flash-1017.');
  }
  return model.replace(/(?::(?:floor|nitro|exacto))+$/, '');
}

function rate(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function responseUsage(response) {
  if (response?.status && !['completed', 'incomplete'].includes(response.status)) {
    return null;
  }
  const usage = response?.usage;
  const input = tokenCount(usage?.input_tokens);
  const output = tokenCount(usage?.output_tokens);
  if (input === undefined || output === undefined) return null;

  const inputDetails = usage.input_tokens_details;
  const promptDetails = usage.prompt_tokens_details;
  const cached = Math.min(input,
    tokenCount(inputDetails?.cached_tokens) ?? tokenCount(promptDetails?.cached_tokens) ?? 0);
  const writes = Math.min(
    input - cached,
    tokenCount(inputDetails?.cache_write_tokens)
      ?? tokenCount(inputDetails?.cache_creation_input_tokens)
      ?? tokenCount(promptDetails?.cache_write_tokens)
      ?? tokenCount(promptDetails?.cache_creation_input_tokens) ?? 0,
  );
  return {
    input, cached, writes, output,
    reasoning: Math.min(output, tokenCount(usage.output_tokens_details?.reasoning_tokens) ?? 0),
  };
}

function usageSamples(history, body) {
  const outputLimit = tokenCount(body.max_output_tokens) ?? Infinity;
  if (history.length) return history.map(row => {
    const output = Math.min(row.output, outputLimit);
    return { ...row, output, reasoning: Math.min(row.reasoning, output) };
  });
  const characters = JSON.stringify([body.input, body.instructions, body.tools]).length;
  return [{ input: Math.max(1, Math.ceil(characters / 4)), cached: 0, writes: 0,
    output: Math.min(512, outputLimit), reasoning: 0 }];
}

function averageUsage(rows) {
  const totals = { input: 0, cached: 0, writes: 0, output: 0, reasoning: 0 };
  for (const row of rows) {
    for (const key of Object.keys(totals)) totals[key] += row[key];
  }
  for (const key of Object.keys(totals)) totals[key] /= rows.length;
  return totals;
}

function providerForecasts(samples, tag, ownSamples, cold) {
  const own = ownSamples && averageUsage(ownSamples);
  return samples.map(sample => {
    const useRatio = own?.input > 0 && sample.endpoint !== tag;
    const cached = useRatio ? sample.input * own.cached / own.input : sample.cached;
    const writes = useRatio ? sample.input * own.writes / own.input : sample.writes;
    return { ...sample, cached: cold ? 0 : cached, writes };
  });
}

function providerMatches(rule, tag) {
  return typeof rule === 'string' && (tag === rule || tag.startsWith(`${rule}/`));
}

function timeMatches(override, now) {
  if (Array.isArray(override.utc_days) && !override.utc_days.includes(WEEKDAYS[now.getUTCDay()])) {
    return false;
  }
  const { utc_start: start, utc_end: end } = override;
  if (start === undefined && end === undefined) return true;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  const clock = now.getUTCHours() * 100 + now.getUTCMinutes();
  return start < end ? clock >= start && clock < end : clock >= start || clock < end;
}

function quote(endpoint, usage, now) {
  const pricing = endpoint.pricing;
  if (!pricing || rate(pricing.prompt) === undefined || rate(pricing.completion) === undefined) {
    return null;
  }
  // The public catalog's unit prices already include pricing.discount. Only
  // apply a separate endpoint-level multiplier if that is the sole discount.
  const discount = pricing.discount == null ? rate(endpoint.discount) ?? 0 : 0;
  if (discount > 1) return null;
  const multiplier = 1 - discount;
  const rates = {};
  for (const key of PRICE_FIELDS) rates[key] = rate(pricing[key]);
  // The true prompt length is unknown until the provider tokenizes the request.
  // Check the cache ceiling against possible length tiers in the active time window.
  let highestCacheRead = rates.input_cache_read;
  for (const override of Array.isArray(pricing.overrides) ? pricing.overrides : []) {
    if (!override || !timeMatches(override, now)) continue;
    const cacheRead = rate(override.input_cache_read);
    if (cacheRead !== undefined && highestCacheRead !== undefined) {
      highestCacheRead = Math.max(highestCacheRead, cacheRead);
    }
    if (Object.keys(override).some(key => !PRICE_OVERRIDE_KEYS.has(key))
      || override.min_prompt_tokens !== undefined && !(usage.input > override.min_prompt_tokens)) {
      continue;
    }
    for (const key of PRICE_FIELDS) rates[key] = rate(override[key]) ?? rates[key];
  }
  for (const key of PRICE_FIELDS) {
    if (rates[key] !== undefined) rates[key] *= multiplier;
  }
  return { rates, highestCacheRead: highestCacheRead === undefined ? undefined : highestCacheRead * multiplier };
}

function estimatedCost(rates, usage, imageCount) {
  const fresh = Math.max(0, usage.input - usage.cached - usage.writes);
  const reasoning = rates.internal_reasoning > 0 ? usage.reasoning : 0;
  return fresh * rates.prompt
    + usage.cached * (rates.input_cache_read ?? rates.prompt)
    + usage.writes * (rates.input_cache_write ?? rates.prompt)
    + (usage.output - reasoning) * rates.completion
    + reasoning * (rates.internal_reasoning ?? 0)
    + (rates.request ?? 0)
    + imageCount * (rates.image ?? 0);
}

function inputRequirements(body) {
  const modalities = new Set(['text']);
  let images = 0;
  let cacheBreakpoint = Boolean(body.cache_control || body.tools?.some?.(tool => tool?.cache_control));
  const pending = Array.isArray(body.input) ? [...body.input] : [body.input];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (item.cache_control || item.prompt_cache_breakpoint) cacheBreakpoint = true;
    if (item.type === 'input_image') {
      modalities.add('image');
      images++;
    }
    if (item.type === 'input_file') modalities.add('file');
    if (item.type === 'input_audio') modalities.add('audio');
    if (Array.isArray(item.content)) pending.push(...item.content);
  }
  return { modalities, images, cacheBreakpoint, tools: body.tools?.some?.(tool => tool?.type === 'function') };
}

function servesRequest(endpoint, body, requirements) {
  const advertisedInputs = endpoint.input_modalities ?? endpoint.architecture?.input_modalities;
  if (Array.isArray(advertisedInputs)
    && [...requirements.modalities].some(modality => !advertisedInputs.includes(modality))) return false;
  const parameters = endpoint.supported_parameters;
  if (requirements.tools && Array.isArray(parameters) && !parameters.includes('tools')) return false;
  if (endpoint.max_completion_tokens > 0 && body.max_output_tokens > endpoint.max_completion_tokens) {
    return false;
  }
  const requested = body.service_tier;
  const tier = endpoint.service_tier;
  if (requested === 'default') return !tier || ['default', 'standard'].includes(tier);
  if (requested === 'flex') return tier === 'flex';
  if (requested === 'fast' || requested === 'priority') return tier === 'priority';
  if (requested === 'ultrafast') return tier === 'ultrafast';
  return true;
}

function withinRequestedBudget(rates, budget) {
  for (const key of ['prompt', 'completion', 'image', 'request']) {
    const limit = rate(budget?.[key]);
    const unit = ['prompt', 'completion'].includes(key) ? PER_MILLION : 1;
    if (limit !== undefined && (rates[key] ?? 0) * unit > limit + 1e-12) return false;
  }
  return true;
}

function withinCacheCeiling(endpoint, priced, endpoints, usage, now, ceiling) {
  if (ceiling === undefined) return true;
  const checks = [priced.highestCacheRead];
  // A flex endpoint can actually serve and bill at the corresponding standard tier.
  if (endpoint.service_tier === 'flex') {
    const standardTag = endpoint.tag.replace(/\/flex$/, '');
    const siblings = endpoints.filter(candidate => candidate.tag === standardTag
      && (!candidate.service_tier || ['default', 'standard'].includes(candidate.service_tier)));
    if (!siblings.length) return false;
    for (const sibling of siblings) checks.push(quote(sibling, usage, now)?.highestCacheRead);
  }
  return checks.every(value => value !== undefined && value * PER_MILLION <= ceiling + 1e-12);
}

export function rankEndpoints({ endpoints, body, history, session, continuation, options = {}, now = new Date() }) {
  const samples = usageSamples(history, body);
  const samplesByEndpoint = Map.groupBy(history, sample => sample.endpoint);
  const requirements = inputRequirements(body);
  const provider = body.provider ?? {};
  const excluded = [...(provider.ignore ?? []), ...(options.ignore ?? [])];
  const allowed = provider.only ?? [];
  const fixedOrder = provider.allow_fallbacks === false ? provider.order ?? [] : [];
  const warm = session && now.getTime() - session.recordedAt <= WARM_CACHE_MS;
  const candidates = [];

  const available = endpoints.filter(endpoint => endpoint.status == null || endpoint.status === 0);
  for (const [tag, variants] of Map.groupBy(available, endpoint => endpoint.tag)) {
    if (!tag || excluded.some(rule => providerMatches(rule, tag))) continue;
    if (allowed.length && !allowed.some(rule => providerMatches(rule, tag))) continue;
    if (fixedOrder.length && !fixedOrder.some(rule => providerMatches(rule, tag))) continue;
    if (continuation && continuation.endpoint !== tag) continue;

    const forecasts = providerForecasts(samples, tag, samplesByEndpoint.get(tag), warm && session.endpoint !== tag);
    // Several catalog rows can share one routing tag. Use the highest estimate
    // for that tag because the request cannot select an individual row.
    const pricedVariants = variants.map(endpoint => {
      if (!servesRequest(endpoint, body, requirements)) return null;
      const canCache = endpoint.supports_implicit_caching !== false || requirements.cacheBreakpoint;
      const billable = canCache ? forecasts : forecasts.map(sample => ({ ...sample, cached: 0, writes: 0 }));
      let totalUsd = 0;
      let totalCacheRate = 0;
      // A tariff can change at a prompt-length threshold. Price the individual
      // requests before averaging, so short and long prompts pay their own rates.
      for (const sample of billable) {
        const priced = quote(endpoint, sample, now);
        if (!priced || !withinRequestedBudget(priced.rates, provider.max_price)
          || !withinCacheCeiling(endpoint, priced, endpoints, sample, now, options.maxCacheRead)) return null;
        totalUsd += estimatedCost(priced.rates, sample, requirements.images);
        totalCacheRate += priced.rates.input_cache_read ?? priced.rates.prompt;
      }
      return {
        tag, tier: endpoint.service_tier ?? null, forecast: averageUsage(billable),
        cacheReadPerMillion: totalCacheRate / billable.length * PER_MILLION,
        estimatedUsd: totalUsd / billable.length,
      };
    });
    if (pricedVariants.some(candidate => candidate === null)) continue;
    candidates.push(pricedVariants.reduce((highest, candidate) => (
      candidate.estimatedUsd > highest.estimatedUsd ? candidate : highest
    )));
  }

  candidates.sort((a, b) => a.estimatedUsd - b.estimatedUsd || a.tag.localeCompare(b.tag));
  return candidates;
}

export function pinnedProvider(original, selectedTag, endpoints) {
  const siblings = endpoints.map(endpoint => endpoint.tag).filter(
    tag => tag && tag !== selectedTag && providerMatches(selectedTag, tag),
  );
  const selection = {
    ...original,
    only: [selectedTag],
    order: [selectedTag],
    ignore: [...new Set([...(original?.ignore ?? []), ...siblings])],
    allow_fallbacks: false,
  };
  delete selection.sort;
  return selection;
}
