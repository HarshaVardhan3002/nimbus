/* Cold-start hypothesis test.
 *
 * A 2B model showing 7.5s TTFT is not arithmetic -- a 2B on an NPU should reach
 * first token in a few hundred ms. The usual cause is the server loading the
 * model per request. If that is it, consecutive calls to the SAME model get
 * dramatically faster and the fix is to keep it resident, not to pick a
 * smaller model.
 */
const BASE = 'http://localhost:8000/v1';

async function ttft(model, prompt, maxTokens = 24) {
  const t0 = Date.now();
  let first = null, tokens = 0, err = null;
  try {
    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: maxTokens })
    });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim(); if (p === '[DONE]') continue;
        try {
          const j = JSON.parse(p);
          if (j.error) { err = j.error.message; continue; }
          const d = j.choices?.[0]?.delta?.content;
          if (d) { if (first === null) first = Date.now() - t0; tokens++; }
        } catch {}
      }
    }
  } catch (e) { err = e.message; }
  return { ttft: first, total: Date.now() - t0, tokens, err };
}

(async () => {
  const model = 'qwen3.5-2b-FLM';
  console.log('=== consecutive calls to ' + model + ' (same model, back to back) ===');
  for (let i = 1; i <= 5; i++) {
    const r = await ttft(model, 'Say the single word: ready.');
    console.log(`  call ${i}: TTFT=${String(r.ttft).padStart(6)}ms  total=${String(r.total).padStart(6)}ms  ${r.tokens} tok ${r.err ? 'ERR ' + r.err.slice(0,40) : ''}`);
  }

  console.log('\n=== alternating between two models (forces reload if single-slot) ===');
  for (let i = 1; i <= 2; i++) {
    for (const m of ['qwen3.5-2b-FLM', 'qwen3.5-4b-FLM']) {
      const r = await ttft(m, 'Say the single word: ready.');
      console.log(`  ${m.padEnd(18)} TTFT=${String(r.ttft).padStart(6)}ms  total=${String(r.total).padStart(6)}ms`);
    }
  }

  console.log('\n=== after a 20s idle gap (does it unload?) ===');
  await new Promise((r) => setTimeout(r, 20000));
  const r = await ttft(model, 'Say the single word: ready.');
  console.log(`  ${model.padEnd(18)} TTFT=${String(r.ttft).padStart(6)}ms  total=${String(r.total).padStart(6)}ms`);
})().catch((e) => { console.error(e.stack); process.exit(1); });
