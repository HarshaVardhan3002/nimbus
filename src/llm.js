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
  if (/image|vision|multimodal|image_url|content parts|not support/.test(msg)) return true;
  // A backend that only says "request failed" with a 400 is ambiguous, but an
  // image is by far the most common reason a request that works without one
  // starts failing, so it is worth one text-only retry to find out.
  if ((status === 400 || status === 422) && err && err.inStream) return true;
  return false;
}

// ------------------------------------------------------------------ openai
async function streamOpenAI({ apiKey, model, baseURL, system, turns, imageDataUrl, maxTokens, onToken, signal }) {
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
  for await (const part of stream) {
    throwIfStreamError(part);
    const choice = part && part.choices && part.choices[0];
    const delta = choice && choice.delta;
    const d = delta && delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

// --------------------------------------------------------------- anthropic
async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, signal }) {
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
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
      full += ev.delta.text;
      onToken(ev.delta.text);
    }
  }
  return full;
}

// ------------------------------------------------------------------ gemini
async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
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
  for await (const chunk of stream) {
    const t = chunk && chunk.text;
    if (t) { full += t; onToken(t); }
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
  const p = providers.TIERS.includes(tierOrId) || tierOrId == null
    ? providers.resolveTier(settings, tierOrId)
    : providers.resolve(settings, tierOrId);

  if (!p) {
    return { ready: false, reason: 'Unknown provider.', provider: providerId, model: null, vision: false };
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

    async stream({ system, turns, imageDataUrl, onToken, signal, maxTokens = 4096, onNotice }) {
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
        signal
      });

      const isAbort = (e) => e && (e.name === 'AbortError' || e.message === 'Request was aborted.');

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
            throw new Error(explain(retryErr, p));
          }
        }

        throw new Error(explain(err, p));
      }
    }
  };
}

module.exports = { createLLM };
