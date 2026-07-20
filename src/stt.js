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

// --------------------------------------------------------------- transports
async function transcribeOpenAICompatible({ baseURL, apiKey, model, language, wav, timeoutMs = 30000 }) {
  const base = (baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {};
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetch(base + '/audio/transcriptions', {
      method: 'POST', headers, body: form, signal: ctrl.signal
    });
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

async function transcribeGemini({ apiKey, wav }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
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
    fn: (wav) => transcribeOpenAICompatible({
      baseURL: cfg.localBaseURL,
      apiKey: '',
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
              ? 'No transcription server at ' + c.endpoint + '. Start faster-whisper-server (or point Settings at another endpoint).'
              : ((e && e.message) || String(e))
          };
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT };
