'use strict';
/**
 * Speech-to-text.
 *
 * Decoupled from the LLM provider on purpose: Anthropic has no audio API, and
 * a local text model has no audio API either, so the transcriber is chosen
 * independently of the chat model.
 *
 * The local path speaks the OpenAI /v1/audio/transcriptions wire format over
 * plain fetch + FormData. That single code path covers faster-whisper-server,
 * whisper.cpp's built-in server, Speaches and LM Studio, so "run Whisper
 * locally" needs no native module, no Python bridge and no rebuild step --
 * it is just a base URL.
 *
 * transcribe(pcm) -> { text, provider } | { text: '', error }
 */

const { pcmToWav } = require('./wav');
const { cachedClient } = require('./clients');

// --------------------------------------------------------------- transports
async function postAudio(url, { apiKey, model, language, wav, timeoutMs = 30000 }) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  if (model) form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {};
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetch(url, { method: 'POST', headers, body: form, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error('HTTP ' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    return ((json && json.text) || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeOpenAICompatible({ baseURL, apiKey, model, language, wav, timeoutMs = 30000 }) {
  const base = (baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return postAudio(base + '/audio/transcriptions', { apiKey, model, language, wav, timeoutMs });
}

/**
 * Local servers, which do not agree on a route.
 *
 * faster-whisper-server, Speaches and LM Studio serve the OpenAI shape at
 * /v1/audio/transcriptions. whisper.cpp's own server -- the one Nimbus
 * downloads and manages -- serves /inference and answers the OpenAI route with
 * a plain 404, so both are tried and the winner is remembered per base URL:
 * one wasted round trip on the first utterance after a settings change, none
 * after that.
 */
const LEARNED = new Map();

function localCandidates(baseURL) {
  const base = (baseURL || 'http://127.0.0.1:8081').replace(/\/+$/, '');
  const versioned = /\/v\d+$/.test(base);
  const origin = versioned ? base.replace(/\/v\d+$/, '') : base;
  return [
    (versioned ? base : base + '/v1') + '/audio/transcriptions',
    origin + '/inference'
  ];
}

async function transcribeLocal({ baseURL, model, language, wav, timeoutMs }) {
  const candidates = localCandidates(baseURL);
  const known = LEARNED.get(baseURL);
  const order = known ? [known, ...candidates.filter((u) => u !== known)] : candidates;

  let lastErr = null;
  for (const url of order) {
    try {
      const text = await postAudio(url, { apiKey: '', model, language, wav, timeoutMs });
      LEARNED.set(baseURL, url);
      return text;
    } catch (e) {
      // Only a wrong route is worth retrying elsewhere; a 500 means the server
      // took the audio and failed, and asking it again on another path will not help.
      if (e && (e.status === 404 || e.status === 405)) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error('no transcription endpoint answered');
}

async function transcribeGemini({ apiKey, wav }) {
  const { GoogleGenAI } = require('@google/genai');
  // Pooled: transcription runs once per utterance, so a per-call client meant a
  // fresh TLS handshake for every phrase spoken.
  const ai = cachedClient('gemini', '', apiKey, () => new GoogleGenAI({ apiKey }));
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [
        { text: 'Transcribe this audio verbatim. Return only the spoken words, no commentary. If there is no clear speech, return nothing.' },
        { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
      ]
    }]
  });
  return ((res && res.text) || '').trim();
}

// ------------------------------------------------------------------ factory
function createSTT(settings) {
  const cfg = (settings && settings.stt) || {};
  const keys = (settings && settings.apiKeys) || {};
  const language = cfg.language || undefined;
  const chain = [];

  const preferred = cfg.provider || 'local';

  const localEntry = {
    p: 'local',
    label: 'local Whisper',
    endpoint: cfg.localBaseURL,
    fn: (wav) => transcribeLocal({
      baseURL: cfg.localBaseURL,
      model: cfg.localModel || 'whisper-1',
      language, wav,
      timeoutMs: 60000 // a cold local model load is slow the first time
    })
  };

  const openaiEntry = keys.openai ? {
    p: 'openai',
    label: 'OpenAI Whisper',
    endpoint: 'https://api.openai.com/v1',
    fn: (wav) => transcribeOpenAICompatible({
      baseURL: 'https://api.openai.com/v1',
      apiKey: keys.openai,
      model: cfg.remoteModel || 'whisper-1',
      language, wav
    })
  } : null;

  const geminiEntry = keys.gemini ? {
    p: 'gemini',
    label: 'Gemini',
    endpoint: 'gemini',
    fn: (wav) => transcribeGemini({ apiKey: keys.gemini, wav })
  } : null;

  if (preferred !== 'off') {
    // Preferred first, then the remaining options as fallbacks.
    const order = { local: [localEntry, openaiEntry, geminiEntry],
                    openai: [openaiEntry, localEntry, geminiEntry],
                    gemini: [geminiEntry, localEntry, openaiEntry] }[preferred]
                  || [localEntry, openaiEntry, geminiEntry];
    for (const e of order) if (e) chain.push(e);
  }

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    primary: chain.length ? chain[0].p : null,

    async transcribe(pcm) {
      if (!chain.length) return { text: '', error: { message: 'Transcription is off.', provider: 'none' } };
      if (!pcm || pcm.length < 3200) return { text: '' };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          return { text, provider: c.p };
        } catch (e) {
          const refused = /ECONNREFUSED|fetch failed|ENOTFOUND|aborted/i.test((e && e.message) || '');
          lastErr = {
            status: e && e.status,
            code: e && e.code,
            provider: c.p,
            label: c.label,
            endpoint: c.endpoint,
            message: refused && c.p === 'local'
              ? 'No transcription server at ' + c.endpoint + '. Install the local engine in Settings, or point it at another endpoint.'
              : ((e && e.message) || String(e))
          };
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT, localCandidates };
