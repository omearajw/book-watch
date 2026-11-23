import { fileURLToPath } from 'url';
import { pipeline, RawImage, env } from '@huggingface/transformers';

// Measured on 31 Vinted Direbound listings (2026-11-23): two photos of the same cover scored
// about 0.7, the standard edition's similar inside art (same artist, same wolf) 0.55 to 0.65,
// everything else 0.35 or less. So above this a listing is worth a look, never proof: it
// shows a badge and doesn't send notifications.
export const LOOKS_LIKE = 0.5;

// A listing photo must also look more like the references than like any cover marked "Not this
// cover". In a leave-one-out test the inside art scored 0.81 to 0.92 against other photos of it
// and at most 0.65 against the FairyLoot cover, while the FairyLoot promo scored 0.72 against the
// reference and 0.62 against the inside art, so this margin rejects one and keeps the other.
export const BEAT_WRONG_BY = 0.05;

// dinov2-base separated covers far better than CLIP or dinov2-small in that test.
const MODEL = 'onnx-community/dinov2-base';
// The workflow caches this folder; the model is about 350 MB.
env.cacheDir = fileURLToPath(new URL('../.cache/models/', import.meta.url));

let extractor;

export async function embed(buffer) {
  extractor ??= await pipeline('image-feature-extraction', MODEL, { dtype: 'fp32' });
  const out = await extractor(await RawImage.fromBlob(new Blob([buffer])));
  // The first token is DINOv2's whole-image summary.
  const v = out.data.slice(0, out.dims.at(-1));
  const norm = Math.hypot(...v);
  return Array.from(v, x => x / norm);
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

async function download(url) {
  const r = await fetch(url).catch(() => null);
  return r?.ok ? Buffer.from(await r.arrayBuffer()) : null;
}

// score: the best match of any listing photo with any reference. best: that photo's bytes, kept
// so a listing marked "Not this cover" can be saved as an example. null if no photo downloaded.
export async function scorePhotos(urls, refs, wrong = []) {
  let result = null;
  for (const url of urls) {
    const buffer = await download(url);
    if (!buffer) continue;
    const v = await embed(buffer);
    const pos = Math.max(...refs.map(r => dot(r, v)));
    const neg = wrong.length ? Math.max(...wrong.map(w => dot(w, v))) : -1;
    result ??= { score: -1, looksLike: false, best: null };
    if (pos > result.score) Object.assign(result, { score: pos, best: buffer });
    if (pos >= LOOKS_LIKE && pos - neg >= BEAT_WRONG_BY) result.looksLike = true;
  }
  if (result) result.score = Math.round(result.score * 100) / 100;
  return result;
}
