/* Does transcription evict the chat model?
 *
 * The server has been shown to be single-slot with idle unload. If Whisper and
 * the chat model share that slot, then EVERY voice turn is:
 *   load Whisper (8s) -> transcribe -> load chat model (8s) -> answer
 * which would make server-side STT unusable for conversation regardless of how
 * fast either model is on its own.
 */
const fs = require('fs'), path = require('path');
const BASE = 'http://localhost:8000/v1';

function readWavInt16(f) {
  const buf = fs.readFileSync(f);
  let off = 12, d = -1, len = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'data') { d = off + 8; len = size; break; }
    off += 8 + size + (size % 2);
  }
  const n = Math.floor(Math.min(len, buf.length - d) / 2), pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(d + i * 2);
  return pcm;
}
function wav(pcm) {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write('RIFF',0); b.writeUInt32LE(36+pcm.length*2,4); b.write('WAVE',8); b.write('fmt ',12);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24);
  b.writeUInt32LE(32000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36);
  b.writeUInt32LE(pcm.length*2,40);
  for (let i=0;i<pcm.length;i++) b.writeInt16LE(pcm[i],44+i*2);
  return b;
}
async function llm(model) {
  const t0 = Date.now(); let first = null;
  const res = await fetch(BASE+'/chat/completions', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ model, messages:[{role:'user',content:'Say: ok'}], stream:true, max_tokens:8 }) });
  const rd = res.body.getReader(), dec = new TextDecoder(); let buf='';
  while (true) { const {done,value}=await rd.read(); if(done)break; buf+=dec.decode(value,{stream:true});
    let i; while((i=buf.indexOf('\n'))>=0){ const L=buf.slice(0,i).trim(); buf=buf.slice(i+1);
      if(!L.startsWith('data:'))continue; const p=L.slice(5).trim(); if(p==='[DONE]')continue;
      try{ const j=JSON.parse(p); if(j.choices?.[0]?.delta?.content && first===null) first=Date.now()-t0; }catch{} } }
  return first;
}
async function stt(pcm) {
  const form = new FormData();
  form.append('file', new Blob([wav(pcm)], {type:'audio/wav'}), 'a.wav');
  form.append('model','Whisper-Large-v3'); form.append('response_format','json'); form.append('language','en');
  const t0=Date.now(); const r=await fetch(BASE+'/audio/transcriptions',{method:'POST',body:form}); await r.json();
  return Date.now()-t0;
}

(async () => {
  const pcm = readWavInt16(path.join(__dirname,'A1.wav')).slice(0, 16000*2);
  const M = 'qwen3.5-2b-FLM';
  console.log('  warming chat model...');
  await llm(M); 
  console.log('  chat warm TTFT: ' + (await llm(M)) + 'ms');
  console.log('  --- now transcribe (different model) ---');
  console.log('  STT: ' + (await stt(pcm)) + 'ms');
  console.log('  --- chat again immediately after STT ---');
  const after = await llm(M);
  console.log('  chat TTFT after STT: ' + after + 'ms');
  console.log('\n  VERDICT: ' + (after > 3000
    ? 'STT EVICTS the chat model -- every voice turn pays a full reload.'
    : 'STT and chat coexist; no eviction.'));
})().catch(e=>{console.error(e.stack);process.exit(1);});
