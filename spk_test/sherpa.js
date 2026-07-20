/* Same audio, same model, reference frontend. Direct A/B against my hand-rolled
 * filterbank so the comparison is like-for-like. */
const fs = require('fs');
const path = require('path');

function readWav(file) {
  const buf = fs.readFileSync(file);
  let off = 12, dataOff = -1, dataLen = 0, rate = 16000;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
    else if (id === 'data') { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size % 2);
  }
  const n = Math.floor(Math.min(dataLen, buf.length - dataOff) / 2);
  const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) f32[i] = buf.readInt16LE(dataOff + i * 2) / 32768; // sherpa wants [-1,1]
  return { samples: f32, rate };
}

function l2(v) { let s = 0; for (const x of v) s += x * x; const n = Math.sqrt(s) || 1; return v.map((x) => x / n); }
function cos(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function centroid(list) {
  const d = list[0].length, acc = new Array(d).fill(0);
  for (const e of list) for (let i = 0; i < d; i++) acc[i] += e[i] / list.length;
  return l2(acc);
}

const sherpa = require('sherpa-onnx-node');
const ex = new sherpa.SpeakerEmbeddingExtractor({
  model: path.join(__dirname, '..', 'models', 'speaker-campplus.onnx'),
  numThreads: 2, debug: false
});
console.log('  extractor dim:', ex.dim);

const names = ['A1','A2','A3','A4','B1','B2'];
const emb = {};
for (const n of names) {
  const { samples, rate } = readWav(path.join(__dirname, n + '.wav'));
  const s = ex.createStream();
  s.acceptWaveform({ sampleRate: rate, samples });
  emb[n] = l2(Array.from(ex.compute(s)));
  console.log(`  ${n}: ${(samples.length/16000).toFixed(2)}s -> dim ${emb[n].length}`);
}

const c = centroid([emb.A1, emb.A2, emb.A3]);
const rows = [
  ['A4 (same speaker, UNSEEN sentence)', cos(emb.A4, c)],
  ['A1 (same speaker, enrolled)       ', cos(emb.A1, c)],
  ['B1 (different speaker)            ', cos(emb.B1, c)],
  ['B2 (different speaker)            ', cos(emb.B2, c)]
];
console.log('\n  === REFERENCE FRONTEND (sherpa-onnx / kaldi-native-fbank) ===');
for (const [l, v] of rows) console.log('  ' + l + '  ' + v.toFixed(4));

const sameMin = Math.min(rows[0][1], rows[1][1]);
const diffMax = Math.max(rows[2][1], rows[3][1]);
console.log('\n  worst same-speaker : ' + sameMin.toFixed(4));
console.log('  best  diff-speaker : ' + diffMax.toFixed(4));
console.log('  margin             : ' + (sameMin - diffMax).toFixed(4));
console.log('\n  (hand-rolled frontend scored: same 0.2981 / diff 0.2699 / margin 0.0281)');

let fail = 0;
const t = (n, c2, e) => { c2 ? console.log('  ok    ' + n) : (fail++, console.log('  FAIL  ' + n + (e ? '  -> ' + e : ''))); };
console.log('');
t('unseen sentence, same speaker > 0.55', rows[0][1] > 0.55, rows[0][1].toFixed(3));
t('different speaker < 0.45', diffMax < 0.45, diffMax.toFixed(3));
t('margin > 0.15', (sameMin - diffMax) > 0.15, (sameMin - diffMax).toFixed(3));
process.exit(fail ? 1 : 0);
