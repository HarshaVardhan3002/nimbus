/* Empirical validation of the speaker-verification stack.
 *
 * The decisive question is NOT "does it run" but "does the embedding encode
 * VOICE rather than CONTENT". A1..A4 are the same synthetic speaker saying four
 * completely different sentences; if the fbank frontend disagreed with what
 * CAM++ was trained on, those would NOT cluster and similarity would sit near
 * the between-speaker range.
 */
const fs = require('fs');
const path = require('path');
const speaker = require('../src/audio/speaker');

function readWavInt16(file) {
  const buf = fs.readFileSync(file);
  // Walk RIFF chunks rather than assuming a 44-byte header; SAPI emits a
  // LIST/INFO chunk before data often enough that a fixed offset is wrong.
  let off = 12, dataOff = -1, dataLen = 0, fmt = {};
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(off + 10),
        rate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22)
      };
    } else if (id === 'data') { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) throw new Error('no data chunk: ' + file);
  const n = Math.floor(Math.min(dataLen, buf.length - dataOff) / 2);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(dataOff + i * 2);
  return { pcm, fmt };
}

(async () => {
  const init = await speaker.init(path.join(__dirname, '..', 'models', 'speaker-campplus.onnx'));
  if (!init.ok) { console.error('INIT FAILED: ' + init.error); process.exit(1); }
  console.log('  model loaded:', path.basename(init.path));

  const names = ['A1', 'A2', 'A3', 'A4', 'B1', 'B2'];
  const emb = {};
  for (const n of names) {
    const { pcm, fmt } = readWavInt16(path.join(__dirname, n + '.wav'));
    const secs = (pcm.length / 16000).toFixed(2);
    const e = await speaker.embed(pcm);
    if (!e) { console.error('  embed failed for ' + n); process.exit(1); }
    emb[n] = e;
    console.log(`  ${n}: ${secs}s  ${fmt.rate}Hz/${fmt.channels}ch/${fmt.bits}bit  -> dim ${e.length}`);
  }

  console.log('\n  === ENROLMENT: centroid from A1,A2,A3 (speaker A) ===');
  const centroid = speaker.centroidOf([emb.A1, emb.A2, emb.A3]);
  const cal = speaker.calibrate([emb.A1, emb.A2, emb.A3, emb.A4]);
  console.log('  leave-one-out genuine scores:', cal.scores.map((s) => s.toFixed(3)).join(', '));
  console.log('  mean ' + cal.mean.toFixed(3) + '  std ' + cal.std.toFixed(3)
              + '  -> suggested threshold ' + cal.threshold.toFixed(3));

  console.log('\n  === SCORES vs enrolled centroid ===');
  const rows = [
    ['A4 (same speaker, unseen sentence)', speaker.cosine(emb.A4, centroid), 'owner'],
    ['A1 (same speaker, enrolled)       ', speaker.cosine(emb.A1, centroid), 'owner'],
    ['B1 (different speaker)            ', speaker.cosine(emb.B1, centroid), 'other'],
    ['B2 (different speaker)            ', speaker.cosine(emb.B2, centroid), 'other']
  ];
  for (const [label, score] of rows) console.log('  ' + label + '  ' + score.toFixed(4));

  const sameMin = Math.min(rows[0][1], rows[1][1]);
  const diffMax = Math.max(rows[2][1], rows[3][1]);
  const gap = sameMin - diffMax;

  console.log('\n  === SEPARATION ===');
  console.log('  worst same-speaker : ' + sameMin.toFixed(4));
  console.log('  best  diff-speaker : ' + diffMax.toFixed(4));
  console.log('  margin             : ' + gap.toFixed(4));

  console.log('\n  === identify() end to end ===');
  const profile = { centroid, threshold: cal.threshold };
  for (const n of ['A4', 'B1']) {
    const { pcm } = readWavInt16(path.join(__dirname, n + '.wav'));
    const r = await speaker.identify(pcm, profile);
    console.log(`  ${n} -> ${r.speaker.padEnd(9)} score=${(r.score||0).toFixed(3)} thr=${(r.threshold||0).toFixed(3)} ${r.reason||''}`);
  }

  let fail = 0;
  const t = (n, c, e) => { c ? console.log('  ok    ' + n) : (fail++, console.log('  FAIL  ' + n + (e ? '  -> ' + e : ''))); };
  console.log('');
  t('same-speaker similarity is high (>0.55)', sameMin > 0.55, sameMin.toFixed(3));
  t('content-invariant: unseen sentence still matches', rows[0][1] > 0.55, rows[0][1].toFixed(3));
  t('different speaker scores lower', diffMax < sameMin, 'diff=' + diffMax.toFixed(3));
  t('clear margin between classes (>0.10)', gap > 0.10, gap.toFixed(3));
  console.log('\n  ' + (fail ? fail + ' FAILED' : 'all checks passed'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR: ' + e.stack); process.exit(1); });
