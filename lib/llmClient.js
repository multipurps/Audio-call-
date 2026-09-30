// Unified LLM client with GPT Luna (OpenAI `gpt-6-luna`) as the primary
// conversation provider, with an optional fal.ai OpenRouter fallback (which
// proxies OpenAI models, not Groq) when FAL_KEY is configured.
//
// Groq support was deliberately REMOVED: the model this app used on Groq
// (llama-3.3-70b-versatile) was decommissioned, and no code path may silently
// route traffic back to Groq. Every provider here speaks the OpenAI
// Chat Completions API and is verified against OpenAI's model catalog:
//   * gpt-6-luna  — https://developers.openai.com/api/docs/models/gpt-6-luna
//                   $0.10/M input, $0.50/M output, text+image input.
//   * gpt-4o-mini — fal OpenRouter fallback model.
//
// All credentials and model identifiers are read exclusively from server-side
// environment variables. No keys are ever exposed to browser clients.

export const DEFAULT_LUNA_MODEL = 'gpt-6-luna';
export const DEFAULT_LUNA_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_FAL_BASE_URL = 'https://fal.run/openrouter/router/openai/v1';
export const DEFAULT_FAL_MODEL = 'openai/gpt-4o-mini';

/**
 * Normalize a base URL so it ends without a trailing slash and can have
 * `/chat/completions` appended cleanly (unless it already ends with
 * `/chat/completions`).
 */
export function buildChatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || DEFAULT_LUNA_BASE_URL).trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

/**
 * Inspect server environment variables and return an ordered list of
 * LLM provider endpoints to try (primary first, then fallbacks).
 *
 * Priority:
 *   1. Explicit `LLM_PROVIDER` ('luna' | 'openai' | 'fal' | 'openrouter')
 *   2. GPT Luna (`LUNA_API_KEY` or `LLM_API_KEY` or `OPENAI_API_KEY`) using
 *      `LLM_MODEL` / `LUNA_MODEL` (defaults to `gpt-6-luna`).
 *   3. Fal OpenRouter fallback (`FAL_KEY`, optional) using `openai/gpt-4o-mini`.
 *
 * `LLM_PROVIDER=groq` is intentionally NOT honoured any more — it resolves to
 * the OpenAI primary instead of silently targeting a removed provider.
 */
export function resolveLlmEndpoints(env = process.env) {
  const safeEnv = env || {};
  const requestedProvider = String(safeEnv.LLM_PROVIDER || '').trim().toLowerCase();
  const lunaKey = (safeEnv.LUNA_API_KEY || safeEnv.LLM_API_KEY || safeEnv.OPENAI_API_KEY || '').trim();
  const falKey = (safeEnv.FAL_KEY || '').trim();

  const lunaBaseUrl = (safeEnv.LUNA_BASE_URL || safeEnv.LLM_BASE_URL || DEFAULT_LUNA_BASE_URL).trim();
  const lunaModel = (safeEnv.LUNA_MODEL || safeEnv.LLM_MODEL || DEFAULT_LUNA_MODEL).trim();

  const endpoints = [];

  const addLuna = () => {
    if (!lunaKey) return;
    endpoints.push({
      provider: 'luna',
      model: lunaModel,
      url: buildChatCompletionsUrl(lunaBaseUrl),
      headers: {
        Authorization: `Bearer ${lunaKey}`,
        'Content-Type': 'application/json',
      },
    });
  };

  const addFal = () => {
    if (!falKey) return;
    endpoints.push({
      provider: 'fal',
      model: DEFAULT_FAL_MODEL,
      url: buildChatCompletionsUrl(DEFAULT_FAL_BASE_URL),
      headers: {
        Authorization: `Key ${falKey}`,
        'Content-Type': 'application/json',
      },
    });
  };

  if (requestedProvider === 'fal' || requestedProvider === 'openrouter') {
    addFal();
    addLuna();
  } else {
    // Default primary: GPT Luna (`luna` / `openai`), with fal as the only
    // optional fallback. There is no Groq endpoint any more.
    addLuna();
    addFal();
  }

  return endpoints;
}

export const resolveLlmProviders = resolveLlmEndpoints;

/**
 * Check whether at least one conversation LLM provider key is configured.
 */
export function hasConfiguredLlm(env = process.env) {
  return resolveLlmEndpoints(env).length > 0;
}

/**
 * Redact any known secret values from an error string before logging.
 */
export function redactSecrets(text, env = process.env) {
  if (!text) return '';
  let out = String(text);
  const candidates = Array.isArray(env)
    ? env
    : [
        env?.LUNA_API_KEY,
        env?.LLM_API_KEY,
        env?.OPENAI_API_KEY,
        env?.GROQ_API_KEY,
        env?.FAL_KEY,
        env?.FISH_API_KEY,
        env?.SUPABASE_SERVICE_ROLE_KEY,
      ];
  for (const secret of candidates) {
    if (secret && secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

/** o-series and gpt-5+/gpt-6 are reasoning models with a different request contract. */
export function isReasoningModel(model) {
  // Strip a router prefix such as "openai/" before matching.
  const bare = String(model || '').replace(/^[^/]+\//, '');
  return /^(o[1-9]|gpt-[5-9])/i.test(bare);
}

/**
 * Build the Chat Completions body for one endpoint.
 *
 * gpt-6 (Luna/Sol/Astra) rejects `max_tokens` with HTTP 400 ("use
 * max_completion_tokens"), rejects non-default `temperature` unless reasoning
 * effort is `none`, and defaults to a slow medium reasoning effort. Voice and
 * chat turns want fast, direct answers, so reasoning models get
 * `reasoning_effort: "none"` (override with LLM_REASONING_EFFORT; note
 * gpt-6-astra and gpt-6.1-sol do not accept "none"). Non-reasoning models
 * (e.g. the fal fallback's gpt-4o-mini) keep the classic parameters.
 */
export function buildChatPayload({
  model,
  messages,
  temperature,
  max_tokens,
  response_format,
  tools,
  tool_choice,
  env = process.env,
} = {}) {
  const payload = { model, messages };
  if (isReasoningModel(model)) {
    const requested = String(env?.LLM_REASONING_EFFORT || '').trim().toLowerCase();
    const effort = REASONING_EFFORTS.has(requested) ? requested : 'none';
    payload.reasoning_effort = effort;
    payload.max_completion_tokens = max_tokens;
    if (effort === 'none') payload.temperature = temperature;
  } else {
    payload.temperature = temperature;
    payload.max_tokens = max_tokens;
  }
  if (response_format) payload.response_format = response_format;
  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
    if (tool_choice !== undefined) payload.tool_choice = tool_choice;
  }
  return payload;
}

/**
 * Call the primary conversation LLM (GPT Luna by default) with automatic
 * fallback to configured secondary providers if the primary fails or is unset.
 */
export async function createChatCompletion({
  messages,
  tools,
  tool_choice,
  response_format,
  temperature = 0.65,
  max_tokens = 450,
  model,
  env = process.env,
  fetchImpl,
  timeoutMs = 22000,
} = {}) {
  const effectiveFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : globalThis.fetch);
  const endpoints = resolveLlmEndpoints(env);
  if (!endpoints.length) {
    return {
      ok: false,
      status: 503,
      data: {},
      provider: 'none',
      model: 'none',
      rawErrorText: 'No LLM API key configured (set LUNA_API_KEY, OPENAI_API_KEY or LLM_API_KEY).',
      errorText: 'No LLM API key configured.',
    };
  }

  let lastFailure = null;

  for (let idx = 0; idx < endpoints.length; idx++) {
    const ep = endpoints[idx];
    const effectiveModel = idx === 0 && model ? model : ep.model;

    const payload = buildChatPayload({
      model: effectiveModel,
      messages,
      temperature,
      max_tokens,
      response_format,
      tools,
      tool_choice,
      env,
    });

    const canAbort = typeof AbortController !== 'undefined' && typeof setTimeout !== 'undefined';
    const controller = canAbort ? new AbortController() : null;
    const timer = canAbort ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const fetchOpts = {
        method: 'POST',
        headers: ep.headers,
        body: JSON.stringify(payload),
      };
      if (controller) fetchOpts.signal = controller.signal;

      const resp = await effectiveFetch(ep.url, fetchOpts);
      if (timer && typeof clearTimeout !== 'undefined') clearTimeout(timer);

      if (resp && resp.ok) {
        const data = typeof resp.json === 'function' ? await resp.json().catch(() => ({})) : {};
        if (Array.isArray(data?.choices) && data.choices.length > 0) {
          return {
            ok: true,
            status: resp.status || 200,
            data,
            provider: ep.provider,
            model: effectiveModel,
          };
        }
      }

      const rawText =
        resp && typeof resp.text === 'function'
          ? await resp.text().catch(() => '')
          : resp && typeof resp.json === 'function'
            ? JSON.stringify(await resp.json().catch(() => ({})))
            : `HTTP ${resp?.status || 502}`;

      console.warn(`[llm] ${ep.provider}/${effectiveModel} failed: HTTP ${resp?.status || 502} ${redactSecrets(rawText, env).slice(0, 200)}`);
      lastFailure = {
        ok: false,
        status: resp?.status || 502,
        data: {},
        provider: ep.provider,
        model: effectiveModel,
        rawErrorText: rawText,
        errorText: redactSecrets(rawText, env).slice(0, 300),
      };
    } catch (err) {
      if (timer && typeof clearTimeout !== 'undefined') clearTimeout(timer);
      const rawText = err?.message || String(err);
      console.warn(`[llm] ${ep.provider}/${effectiveModel} request error: ${redactSecrets(rawText, env).slice(0, 200)}`);
      lastFailure = {
        ok: false,
        status: 502,
        data: {},
        provider: ep.provider,
        model: effectiveModel,
        rawErrorText: rawText,
        errorText: redactSecrets(rawText, env).slice(0, 300),
      };
    }
  }

  return (
    lastFailure || {
      ok: false,
      status: 502,
      data: {},
      provider: 'unknown',
      model: 'unknown',
      rawErrorText: 'All configured LLM providers failed.',
      errorText: 'All configured LLM providers failed.',
    }
  );
}

/**
 * High-level wrapper around `createChatCompletion` that extracts `content`
 * and `message` directly for relay and voice turns.
 */
export async function generateChatCompletion({
  messages,
  tools,
  tool_choice,
  response_format,
  temperature = 0.65,
  maxTokens,
  max_tokens,
  model,
  env = process.env,
  fetchImpl,
  timeoutMs = 22000,
} = {}) {
  const res = await createChatCompletion({
    messages,
    tools,
    tool_choice,
    response_format,
    temperature,
    max_tokens: maxTokens ?? max_tokens ?? 450,
    model,
    env,
    fetchImpl,
    timeoutMs,
  });
  const message = res.data?.choices?.[0]?.message || null;
  const content = typeof message?.content === 'string' ? message.content.trim() : '';
  return {
    ...res,
    message,
    content,
  };
}

