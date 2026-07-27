'use strict';
/**
 * Streaming LLM transport.
 *
 * One interface, three wire formats. Anything OpenAI-compatible (OpenAI, NVIDIA
 * NIM, Ollama, LM Studio, vLLM, llama.cpp server, TabbyAPI, OpenRouter, Groq)
 * goes through the same function with a different baseURL.
 *
 * stream({ system, turns, imageDataUrl, onToken, signal }) -> Promise<string>
 */

const providers = require('./providers');

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

/**
 * Errors delivered INSIDE a 200 response.
 *
 * Not every OpenAI-compatible server signals failure with an HTTP status. A
 * real one observed here (Lemonade proxying a cloud backend) answers
 * `200 OK` and then writes this as the first and only SSE frame:
 *
 *   data: {"error":{"message":"cloud (academiccloud) request failed",
 *                   "status_code":400,"type":"backend_error"}}
 *
 * The SDK does not throw for that -- there is nothing to throw about, the
 * transport succeeded. Without an explicit check the loop simply yields no
 * content and the user gets a silent empty answer. So every chunk is inspected
 * before it is read for text.
 */
function throwIfStreamError(part) {
  const err = part && part.error;
  if (!err) return;
  const e = new Error((err.message || 'the provider returned an error inside the stream'));
  e.status = err.status_code || err.code || null;
  e.providerType = err.type || null;
  e.inStream = true;
  throw e;
}

/** Does this failure look like "the model cannot accept an image"? */
function looksLikeVisionRejection(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  const status = err && (err.status || err.statusCode);
  // The model answered; it just answered with nothing. Retrying without the
  // image would burn a second round trip on the same outcome.
  if (err && err.emptyAnswer) return false;
  if (/image|vision|multimodal|image_url|content parts|not support/.test(msg)) return true;
  // A backend that only says "request failed" with a 400 is ambiguous, but an
  // image is by far the most common reason a request that works without one
  // starts failing, so it is worth one text-only retry to find out.
  if ((status === 400 || status === 422) && err && err.inStream) return true;
  return false;
}

/**
 * Reasoning deltas.
 *
 * A reasoning model streams its scratchpad in a delta field that is NOT
 * `content`, and there is no agreed name for it:
 *
 *   vLLM / Academic Cloud / DeepSeek   delta.reasoning
 *   OpenRouter / Fireworks / others    delta.reasoning_content
 *   a few servers                      delta.thinking
 *
 * Reading only `delta.content` therefore produced a completely silent, empty
 * answer with no error at all -- measured against qwen3.6-27b, where 200 of 200
 * budgeted tokens arrived as `reasoning` and the single `content` delta was the
 * empty string. The transport succeeded, the SDK had nothing to throw, and the
 * user got a blank bubble. So the reasoning channel is read explicitly, shown
 * live, and counted.
 */
function reasoningDelta(delta) {
  if (!delta) return '';
  const v = delta.reasoning_content != null ? delta.reasoning_content
    : delta.reasoning != null ? delta.reasoning
    : delta.thinking;
  return typeof v === 'string' ? v : '';
}

/** Thrown when a model spent its whole budget thinking and never answered. */
function emptyAnswerError(model, reasoningChars, finishReason) {
  const e = new Error(
    '"' + model + '" produced ' + reasoningChars + ' characters of reasoning and then ran out of '
    + 'room before writing an answer'
    + (finishReason === 'length' ? ' (finish_reason: length)' : '')
    + '. Raise the reply length, or route this tier to a non-reasoning model.'
  );
  e.emptyAnswer = true;
  return e;
}

// ------------------------------------------------------------------ openai
async function streamOpenAI({ apiKey, model, baseURL, system, turns, imageDataUrl, maxTokens, onToken, onReasoning, onNotice, signal }) {
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey: apiKey || providers.NO_KEY,
    baseURL: baseURL || undefined,
    // Local servers on a cold model load routinely exceed the default timeout,
    // and the SDK's automatic retry would re-queue a prompt we already streamed.
    maxRetries: 1,
    timeout: 120000
  });

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  turns.forEach((t, i) => {
    const isLast = i === turns.length - 1;
    if (isLast && imageDataUrl && t.role === 'user') {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: t.text },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });

  const stream = await client.chat.completions.create(
    { model, messages, stream: true, max_tokens: maxTokens },
    { signal }
  );

  let full = '';
  let reasoning = '';
  let finishReason = null;
  for await (const part of stream) {
    throwIfStreamError(part);
    const choice = part && part.choices && part.choices[0];
    if (choice && choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice && choice.delta;
    const d = delta && delta.content;
    if (d) { full += d; onToken(d); }
    const r = reasoningDelta(delta);
    if (r) { reasoning += r; if (onReasoning) onReasoning(r); }
  }

  // Silence is never an acceptable outcome. Either the model thought itself out
  // of tokens (actionable, so say so), or the server returned nothing at all.
  if (!full.trim()) {
    if (reasoning.trim()) throw emptyAnswerError(model, reasoning.trim().length, finishReason);
    throw new Error('"' + model + '" returned an empty response'
      + (finishReason ? ' (finish_reason: ' + finishReason + ')' : '') + '.');
  }
  if (finishReason === 'length' && onNotice) {
    onNotice({ level: 'warn', message: 'The answer was cut off at the reply-length limit.' });
  }
  return full;
}

// --------------------------------------------------------------- anthropic
async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, onReasoning, onNotice, signal }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, maxRetries: 1 });

  const messages = turns.map((t, i) => {
    const isLast = i === turns.length - 1;
    if (isLast && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });

  const stream = await client.messages.create(
    { model, max_tokens: maxTokens, system, messages, stream: true },
    { signal }
  );

  let full = '';
  let reasoning = '';
  let stopReason = null;
  for await (const ev of stream) {
    if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
    if (ev.type !== 'content_block_delta' || !ev.delta) continue;
    if (ev.delta.type === 'text_delta') {
      full += ev.delta.text;
      onToken(ev.delta.text);
    } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
      // Extended thinking arrives on its own block type, exactly like the
      // OpenAI-compatible `reasoning` channel.
      reasoning += ev.delta.thinking;
      if (onReasoning) onReasoning(ev.delta.thinking);
    }
  }

  if (!full.trim()) {
    if (reasoning.trim()) throw emptyAnswerError(model, reasoning.trim().length, stopReason === 'max_tokens' ? 'length' : stopReason);
    throw new Error('"' + model + '" returned an empty response'
      + (stopReason ? ' (stop_reason: ' + stopReason + ')' : '') + '.');
  }
  if (stopReason === 'max_tokens' && onNotice) {
    onNotice({ level: 'warn', message: 'The answer was cut off at the reply-length limit.' });
  }
  return full;
}

// ------------------------------------------------------------------ gemini
async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, onReasoning }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const contents = turns.map((t, i) => {
    const isLast = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (isLast && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });

  const stream = await ai.models.generateContentStream({
    model,
    contents,
    config: { systemInstruction: system, maxOutputTokens: maxTokens }
  });

  let full = '';
  let reasoning = '';
  for await (const chunk of stream) {
    /**
     * Thinking parts are marked `thought: true` and must not be concatenated
     * into the answer. `chunk.text` throws them in together, so the parts are
     * walked directly and the two channels kept apart.
     */
    const parts = ((((chunk || {}).candidates || [])[0] || {}).content || {}).parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (typeof p.text !== 'string' || !p.text) continue;
        if (p.thought) { reasoning += p.text; if (onReasoning) onReasoning(p.text); }
        else { full += p.text; onToken(p.text); }
      }
      continue;
    }
    const t = chunk && chunk.text;
    if (t) { full += t; onToken(t); }
  }

  if (!full.trim()) {
    if (reasoning.trim()) throw emptyAnswerError(model, reasoning.trim().length, null);
    throw new Error('"' + model + '" returned an empty response.');
  }
  return full;
}

const TRANSPORTS = {
  openai: streamOpenAI,
  anthropic: streamAnthropic,
  gemini: streamGemini
};

/**
 * Turn a provider error into something a user can act on. Raw SDK errors are
 * either a bare "fetch failed" or a wall of JSON, and neither tells you that
 * your Ollama server is not running.
 */
function explain(err, p) {
  const msg = (err && err.message) || String(err);
  const status = err && (err.status || err.statusCode);
  // Already a complete, model-named sentence. Wrapping it would repeat the
  // model name and bolt a meaningless "(HTTP )" onto the end.
  if (err && err.emptyAnswer) return msg;
  const where = p.baseURL ? ' (' + p.baseURL + ')' : '';
  // Always name the model. "Ollama: request failed" is useless when the slot is
  // pointed at some other server and one of twenty models is selected.
  const who = p.label + ' / ' + (p.model || 'no model');

  if (/ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET/i.test(msg)) {
    return 'Cannot reach ' + p.label + ' at ' + (p.baseURL || 'its endpoint') + '. Is the server running?';
  }
  if (status === 401 || status === 403) {
    return who + ' rejected the API key (HTTP ' + status + ')' + where + '.';
  }
  if (status === 404) {
    return who + ': model not found (HTTP 404). Click "Refresh model list" in Settings to see what is actually loaded.';
  }
  if (looksLikeVisionRejection(err) && p.vision) {
    return who + ' rejected the request with an image attached. It is probably text-only — '
      + 'untick "Model can see images" for this model, or pick one tagged vision.';
  }
  const code = status ? ' (HTTP ' + status + ')' : '';
  const kind = err && err.providerType ? ' [' + err.providerType + ']' : '';
  return who + code + kind + where + ': ' + msg;
}

/**
 * @param settings  full settings object
 * @param tierOrId  'fast' | 'smart' to resolve through routes, or an explicit
 *                  provider id to bypass routing (used by discovery).
 */
function createLLM(settings, tierOrId) {
  // ROUTE_TIERS, not TIERS: 'vision' is a route too. Testing against the
  // fast/smart pair sent 'vision' down the provider-id branch, where it resolved
  // to nothing and then crashed on the line below.
  const isRoute = tierOrId == null || providers.ROUTE_TIERS.includes(tierOrId);
  const p = isRoute
    ? providers.resolveTier(settings, tierOrId)
    : providers.resolve(settings, tierOrId);

  if (!p) {
    return {
      ready: false,
      reason: isRoute
        ? 'No provider is configured for the ' + (tierOrId || 'active') + ' route.'
        : 'Unknown provider "' + tierOrId + '".',
      provider: isRoute ? null : tierOrId,
      label: tierOrId || 'unset',
      model: null,
      vision: false,
      // `stream` must exist even on an unusable instance: callers check `ready`,
      // but a mistake there should surface as the reason, not as
      // "activeLLM.stream is not a function".
      async stream() { throw new Error('This route is not configured.'); }
    };
  }

  return {
    provider: p.id,
    label: p.label,
    model: p.model,
    tier: p.tier,
    routed: !!p.routed,
    vision: p.vision,
    local: !!p.local,
    baseURL: p.baseURL,
    ready: p.ready,
    reason: p.reason,

    async stream({ system, turns, imageDataUrl, onToken, onReasoning, signal, maxTokens = 4096, onNotice }) {
      const transport = TRANSPORTS[p.kind];
      if (!transport) throw new Error('No transport for provider kind "' + p.kind + '".');

      // Never ship an image to a model flagged as text-only: it either 400s or,
      // worse, silently drops it and answers about nothing.
      const image = p.vision ? imageDataUrl : null;

      const run = (img) => transport({
        apiKey: p.apiKey,
        model: p.model,
        baseURL: p.baseURL,
        system,
        turns,
        imageDataUrl: img,
        maxTokens,
        onToken,
        onReasoning,
        onNotice,
        signal
      });

      const isAbort = (e) => e && (e.name === 'AbortError' || e.message === 'Request was aborted.');

      /**
       * Re-wrapping loses the flags the caller branches on. `emptyAnswer` in
       * particular is the difference between "this provider is broken" and
       * "this provider works, raise the reply length" -- the connection test
       * reported the second case as a hard failure until this carried it.
       */
      const rethrow = (e) => {
        const out = new Error(explain(e, p));
        if (e && e.emptyAnswer) out.emptyAnswer = true;
        if (e && e.status) out.status = e.status;
        throw out;
      };

      try {
        return await run(image);
      } catch (err) {
        if (isAbort(err)) { const e = new Error('aborted'); e.aborted = true; throw e; }

        /**
         * One text-only retry when an image looks like the culprit.
         *
         * A vision capability flag is a guess unless the server labelled the
         * model, and getting it wrong turns an answerable question into a hard
         * failure. Retrying without the screenshot converts that into a
         * slightly-degraded answer plus an explanation, which is almost always
         * what the user actually wanted.
         *
         * Only ever retried once, and only when an image was actually sent.
         */
        if (image && looksLikeVisionRejection(err)) {
          try {
            const out = await run(null);
            if (typeof onNotice === 'function') {
              onNotice({
                level: 'warn',
                message: '"' + p.model + '" rejected the screenshot, so it answered from text only. '
                  + 'Untick "Model can see images" for this model in Settings to stop attaching one.',
                visionFailed: true,
                provider: p.id
              });
            }
            return out;
          } catch (retryErr) {
            if (isAbort(retryErr)) { const e = new Error('aborted'); e.aborted = true; throw e; }
            rethrow(retryErr);
          }
        }

        rethrow(err);
      }
    }
  };
}

/**
 * End-to-end connection test for one provider.
 *
 * "Refresh model list" only proves the endpoint answers a GET. It does not
 * prove the key can generate, that the model NAME is right, or that the model
 * is loaded -- which is where connecting a provider actually goes wrong. This
 * does the whole round trip and names the step that failed.
 *
 * A model that thinks past its budget is reported as a WARNING, not a failure:
 * the connection is provably fine, the reply length is what needs raising.
 */
async function testConnection(settings, id, { maxTokens = 512 } = {}) {
  /**
   * Which model to test with.
   *
   * A provider's own fast/smart fields are the first choice, but they are not
   * the only place a model is chosen: the routing UI writes to settings.routes,
   * so a perfectly configured provider whose model was picked there would
   * otherwise be told to "pick a model first" -- a false failure on the exact
   * screen meant to end guesswork.
   */
  const direct = providers.resolve(settings, id);
  if (!direct) return { ok: false, level: 'error', message: 'Unknown provider.' };

  let p = direct;
  if (!p.model) {
    const routes = settings.routes || {};
    const tier = providers.ROUTE_TIERS.find((t) => {
      const r = routes[t];
      return r && r.provider === id && (r.model || '').trim();
    });
    if (tier) {
      const model = routes[tier].model.trim();
      const models = Object.assign({}, settings.models);
      models[id] = Object.assign({}, models[id], { fast: model, smart: model });
      settings = Object.assign({}, settings, { models, smart: false });
      p = providers.resolve(settings, id);
    }
  }
  if (!p.model) {
    return { ok: false, level: 'error', message: 'Pick a model for ' + p.label + ' first.' };
  }
  if (p.needsKey && !p.hasKey) {
    return { ok: false, level: 'error', message: 'Add an API key for ' + p.label + '.' };
  }

  let listed = null;
  if (p.kind === providers.OPENAI_COMPATIBLE) {
    const d = await providers.discoverModels(settings, id);
    if (!d.ok) return { ok: false, level: 'error', message: d.error };
    listed = d.models;
    // Catch the single most common connection mistake -- a model name that the
    // server has never heard of -- before spending a generation on it.
    if (listed.length && !listed.some((m) => m.id === p.model)) {
      return {
        ok: false,
        level: 'error',
        message: 'Reachable, key accepted, but "' + p.model + '" is not on this server. '
          + listed.length + ' models are: ' + listed.slice(0, 3).map((m) => m.id).join(', ')
          + (listed.length > 3 ? ', …' : '') + '.'
      };
    }
  }

  const llm = createLLM(settings, id);
  const t0 = Date.now();
  let firstTokenMs = null;
  try {
    const out = await llm.stream({
      system: 'Reply with the single word OK and nothing else.',
      turns: [{ role: 'user', text: 'Connection test.' }],
      maxTokens,
      onToken: () => { if (firstTokenMs == null) firstTokenMs = Date.now() - t0; }
    });
    const ms = Date.now() - t0;
    return {
      ok: true,
      level: 'ok',
      latencyMs: ms,
      firstTokenMs,
      models: listed ? listed.length : null,
      message: 'Connected. ' + p.label + ' / ' + p.model + ' replied '
        + JSON.stringify(out.trim().slice(0, 24)) + ' in ' + ms + 'ms'
        + (firstTokenMs != null ? ' (' + firstTokenMs + 'ms to first token)' : '') + '.'
    };
  } catch (e) {
    if (e && e.emptyAnswer) {
      return {
        ok: true,
        level: 'warn',
        models: listed ? listed.length : null,
        message: 'Connected, but ' + e.message
      };
    }
    return { ok: false, level: 'error', message: (e && e.message) || String(e) };
  }
}

module.exports = { createLLM, testConnection };
