/* End-to-end check of the shipped module through its real public API. */
const path = require('path');
const fs = require('fs');
const speaker = require('../src/audio/speaker');

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

(async () => {
  const init = await speaker.init(path.join(__dirname, '..', 'models', 'speaker-campplus.onnx'));
  const st = speaker.status();
  console.log('  backend: ' + st.backend + (st.degraded ? '  (DEGRADED)' : '') + '   dim ' + st.dim);
  if (!init.ok) { console.error('  init failed: ' + init.error); process.exit(1); }

  const pcm = {};
  for (const n of ['A1','A2','A3','A4','B1','B2']) pcm[n] = readWavInt16(path.join(__dirname, n + '.wav'));

  const embs = {};
  for (const n of Object.keys(pcm)) embs[n] = await speaker.embed(pcm[n]);

  const centroid = speaker.centroidOf([embs.A1, embs.A2, embs.A3]);
  const cal = speaker.calibrate([embs.A1, embs.A2, embs.A3, embs.A4]);
  console.log('  calibrated threshold: ' + cal.threshold.toFixed(3)
              + '   (genuine mean ' + cal.mean.toFixed(3) + ' std ' + cal.std.toFixed(3) + ')');

  const profile = { centroid, threshold: cal.threshold };
  console.log('\n  === identify() ===');
  const results = {};
  for (const n of ['A4','A2','B1','B2']) {
    const r = await speaker.identify(pcm[n], profile);
    results[n] = r;
    console.log(`  ${n} -> ${r.speaker.padEnd(9)} score=${(r.score||0).toFixed(3)} thr=${(r.threshold||0).toFixed(3)} ${(r.reason||'')}`);
  }

  // Short-utterance guard
  const short = pcm.A1.slice(0, 16000 * 0.8);
  const rShort = await speaker.identify(short, profile);
  console.log(`  0.8s clip -> ${rShort.speaker}  (${rShort.reason})`);

  let fail = 0;
  const t = (n, c, e) => { c ? console.log('  ok    ' + n) : (fail++, console.log('  FAIL  ' + n + (e ? '  -> ' + e : ''))); };
  console.log('');
  t('using the reference frontend', st.backend === 'sherpa', st.backend);
  t('unseen sentence identified as owner', results.A4.speaker === 'owner', results.A4.speaker + ' @' + results.A4.score.toFixed(3));
  t('enrolled sentence identified as owner', results.A2.speaker === 'owner', results.A2.speaker);
  t('different speaker rejected (B1)', results.B1.speaker === 'other', results.B1.speaker + ' @' + results.B1.score.toFixed(3));
  t('different speaker rejected (B2)', results.B2.speaker === 'other', results.B2.speaker + ' @' + results.B2.score.toFixed(3));
  t('sub-1.5s clip refuses to guess', rShort.speaker === 'uncertain', rShort.speaker);
  t('embeddings are unit length', Math.abs(Math.sqrt(embs.A1.reduce((a,b)=>a+b*b,0)) - 1) < 1e-5);
  console.log('\n  ' + (fail ? fail + ' FAILED' : 'all checks passed'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR: ' + e.stack); process.exit(1); });
