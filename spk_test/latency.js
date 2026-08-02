/* Measures the real end-to-end voice-turn latency budget on this machine.
 *
 * A voice assistant lives or dies on time-to-first-token, and every stage
 * before the LLM is dead time the user experiences as lag:
 *
 *   speech ends -> VAD hangover -> STT -> speaker verify -> LLM TTFT -> answer
 *
 * Guessing at these numbers produces the wrong architecture, so measure them.
 */
const fs = require('fs');
const path = require('path');

function readWavInt16(file) {
  const buf = fs.readFileSync(file);
  let off = 12, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size % 2);
  }
  const n = Math.floor(Math.min(dataLen, buf.length - dataOff) / 2);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(dataOff + i * 2);
  return pcm;
}
function wavBytes(pcm) {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i], 44 + i * 2);
  return b;
}

const BASE = 'http://localhost:8000/v1';

async function timeSTT(pcm, label) {
  const form = new FormData();
  form.append('file', new Blob([wavBytes(pcm)], { type: 'audio/wav' }), 'a.wav');
  form.append('model', 'Whisper-Large-v3');
  form.append('response_format', 'json');
  form.append('language', 'en');
  const t0 = Date.now();
  const r = await fetch(BASE + '/audio/transcriptions', { method: 'POST', body: form });
  const j = await r.json();
  const ms = Date.now() - t0;
  const audioMs = (pcm.length / 16000) * 1000;
  console.log(`  STT ${label.padEnd(8)} audio=${(audioMs/1000).toFixed(1)}s  latency=${String(ms).padStart(6)}ms  RTF=${(ms/audioMs).toFixed(2)}x  "${(j.text||'').trim().slice(0,42)}"`);
  return ms;
}

async function timeLLM(model, prompt) {
  const t0 = Date.now();
  let ttft = null, tokens = 0, err = null;
  try {
    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: 120 })
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j.error) { err = j.error.message; continue; }
          const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (d) { if (ttft === null) ttft = Date.now() - t0; tokens++; }
        } catch {}
      }
    }
  } catch (e) { err = e.message; }
  const total = Date.now() - t0;
  const tps = tokens && total > (ttft||0) ? (tokens / ((total - (ttft||0)) / 1000)) : 0;
  if (err) console.log(`  LLM ${model.padEnd(42)} ERROR: ${err.slice(0,50)}`);
  else console.log(`  LLM ${model.padEnd(42)} TTFT=${String(ttft).padStart(6)}ms  total=${String(total).padStart(6)}ms  ${tokens} tok  ${tps.toFixed(1)} tok/s`);
  return { ttft, total, tokens, tps, err };
}

(async () => {
  const speaker = require('../src/audio/speaker');
  await speaker.init(path.join(__dirname, '..', 'models', 'speaker-campplus.onnx'));

  const a1 = readWavInt16(path.join(__dirname, 'A1.wav'));
  const short = a1.slice(0, 16000 * 2);
  const long = Int16Array.from([...a1, ...a1, ...a1]);

  console.log('\n=== 1. SPEAKER VERIFICATION (local, CAM++ 28MB) ===');
  await speaker.embed(short); // warm
  for (const [lbl, pcm] of [['2s', short], ['3.8s', a1], ['11s', long]]) {
    const t0 = Date.now(); await speaker.embed(pcm); const ms = Date.now() - t0;
    console.log(`  embed ${lbl.padEnd(6)} ${String(ms).padStart(5)}ms`);
  }

  console.log('\n=== 2. STT (Whisper-Large-v3 on NPU) ===');
  await timeSTT(short, 'warmup');
  await timeSTT(short, '2s');
  await timeSTT(a1, '3.8s');
  await timeSTT(long, '11s');

  console.log('\n=== 3. LLM time-to-first-token ===');
  const prompt = 'Reply in one short sentence: what is the capital of France?';
  // Override with NIMBUS_BENCH_MODELS="local-model,cloud-model" to measure your own.
  const models = (process.env.NIMBUS_BENCH_MODELS || 'qwen3.5-2b-FLM,qwen3.5-4b-FLM')
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const m of models) await timeLLM(m, prompt);

  console.log('\n=== 4. BUDGET (VAD hangover 550ms + STT + verify + TTFT) ===');
  console.log('  numbers above; see summary.');
})().catch((e) => { console.error(e.stack); process.exit(1); });
