import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { pipeline, RawImage, env } from '@huggingface/transformers';

// Measured on 31 Vinted Direbound listings (2026-11-23): two photos of the same cover scored
// about 0.7, the standard edition's similar inside art (same artist, same wolf) 0.55 to 0.65,
// everything else 0.35 or less. So above this a listing is worth a look, never proof: it
// shows a badge and doesn't send notifications.
export const LOOKS_LIKE = 0.5;

// dinov2-base separated covers far better than CLIP or dinov2-small in that test.
const MODEL = 'onnx-community/dinov2-base';
// The workflow caches this folder; the model is about 350 MB.
env.cacheDir = fileURLToPath(new URL('../.cache/models/', import.meta.url));

let extractor;

async function embed(blob) {
  extractor ??= await pipeline('image-feature-extraction', MODEL, { dtype: 'fp32' });
  const out = await extractor(await RawImage.fromBlob(blob));
  // The first token is DINOv2's whole-image summary.
  const v = out.data.slice(0, out.dims.at(-1));
  const norm = Math.hypot(...v);
  return Array.from(v, x => x / norm);
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

export const embedFile = async path => embed(new Blob([await readFile(path)]));

// Best score of any listing photo against any reference, or null if no photo could be fetched.
export async function bestMatch(refs, urls) {
  let best = null;
  for (const url of urls) {
    const r = await fetch(url).catch(() => null);
    if (!r?.ok) continue;
    const v = await embed(await r.blob());
    for (const ref of refs) best = Math.max(best ?? -1, dot(ref, v));
  }
  return best == null ? null : Math.round(best * 100) / 100;
}
