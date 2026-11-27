/*
 * Automatic leaf finder for field photos (no black board).
 *
 * Uses SlimSAM (a compressed Segment Anything model) via ONNX Runtime Web,
 * both bundled with the app so it works offline. The image encoder runs once
 * per photo; each tap (add / remove point) only re-runs the small decoder.
 *
 *   const seg = await import("./segment.js");
 *   await seg.load(progress => ...);          // first use downloads ~25 MB, then cached
 *   const handle = await seg.embed(imageData);
 *   const roi = await seg.mask(handle, [{x, y, label: 1}]);   // Uint8Array, 1 = leaf
 */

const BASE = new URL("./", import.meta.url);
const MODEL_DIR = new URL("models/slimsam/", BASE).href;
const ORT_DIR = new URL("vendor/ort/", BASE).href;
const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let ort = null;
let sessions = null;
let loading = null;

// Download with progress so the first use can show "Downloading leaf finder… 40%"
async function fetchBytes(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not download the leaf finder (" + res.status + ")");
  const total = +res.headers.get("content-length") || 0;
  if (!res.body || !total) { const b = new Uint8Array(await res.arrayBuffer()); onBytes(b.length, b.length); return b; }
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got);
    got += value.length;
    onBytes(got, total);
  }
  return got === total ? out : out.slice(0, got);
}

export function isLoaded() { return !!sessions; }

export function load(onProgress) {
  if (sessions) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    ort = await import(ORT_DIR + "ort.wasm.min.mjs");
    ort.env.wasm.wasmPaths = ORT_DIR;
    // Threads need a cross-origin isolated page; otherwise run single-threaded
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    const sizes = [8882165, 4903810];  // encoder, decoder (for a smooth progress bar)
    const done = [0, 0];
    const report = () => onProgress && onProgress((done[0] + done[1]) / (sizes[0] + sizes[1]));
    const [encBytes, decBytes] = await Promise.all([
      fetchBytes(MODEL_DIR + "vision_encoder_quantized.onnx", (g) => { done[0] = g; report(); }),
      fetchBytes(MODEL_DIR + "prompt_encoder_mask_decoder_quantized.onnx", (g) => { done[1] = g; report(); })
    ]);
    const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    sessions = {
      enc: await ort.InferenceSession.create(encBytes, opts),
      dec: await ort.InferenceSession.create(decBytes, opts)
    };
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

/* Resize longest side to 1024, normalise, pad, run the image encoder once. */
export async function embed(imageData) {
  await load();
  const W = imageData.width, H = imageData.height;
  const k = SIZE / Math.max(W, H);
  const rw = Math.round(W * k), rh = Math.round(H * k);
  const src = document.createElement("canvas");
  src.width = W; src.height = H;
  src.getContext("2d").putImageData(imageData, 0, 0);
  const c = document.createElement("canvas");
  c.width = rw; c.height = rh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, rw, rh);
  const px = ctx.getImageData(0, 0, rw, rh).data;
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);   // zero padding right/bottom
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const p = (y * rw + x) * 4, o = y * SIZE + x;
      input[o] = (px[p] / 255 - MEAN[0]) / STD[0];
      input[plane + o] = (px[p + 1] / 255 - MEAN[1]) / STD[1];
      input[2 * plane + o] = (px[p + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  const out = await sessions.enc.run({ pixel_values: new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) });
  return { W, H, k, emb: out.image_embeddings, pos: out.image_positional_embeddings };
}

/*
 * points: [{x, y, label}] in image pixels; label 1 = leaf, 0 = not leaf.
 * Returns a Uint8Array mask (1 = leaf) at image size: the part connected to
 * the leaf points, with holes filled so lesions inside the leaf are kept.
 */
export async function mask(h, points) {
  const n = points.length;
  const coords = new Float32Array(n * 2);
  const labels = new BigInt64Array(n);
  points.forEach((p, i) => { coords[2 * i] = p.x * h.k; coords[2 * i + 1] = p.y * h.k; labels[i] = BigInt(p.label); });
  const out = await sessions.dec.run({
    input_points: new ort.Tensor("float32", coords, [1, 1, n, 2]),
    input_labels: new ort.Tensor("int64", labels, [1, 1, n]),
    image_embeddings: h.emb,
    image_positional_embeddings: h.pos
  });
  const iou = out.iou_scores.data;
  let best = 0;
  for (let i = 1; i < 3; i++) if (iou[i] > iou[best]) best = i;
  const logits = out.pred_masks.data.subarray(best * 256 * 256, (best + 1) * 256 * 256);

  // 256x256 low-res logits cover the padded 1024 square: bilinear upsample to the image
  const W = h.W, H = h.H, s = h.k / 4;
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(255, Math.max(0, (y + 0.5) * s - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(255, y0 + 1), wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(255, Math.max(0, (x + 0.5) * s - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(255, x0 + 1), wx = fx - x0;
      const v = (logits[y0 * 256 + x0] * (1 - wx) + logits[y0 * 256 + x1] * wx) * (1 - wy) +
                (logits[y1 * 256 + x0] * (1 - wx) + logits[y1 * 256 + x1] * wx) * wy;
      if (v > 0) m[y * W + x] = 1;
    }
  }
  const seeds = points.filter((p) => p.label === 1);
  const kept = keepConnected(m, W, H, seeds);
  return { roi: fillHoles(kept, W, H), score: iou[best] };
}

// Keep only the regions touching a leaf point (drops stray neighbouring leaves)
function keepConnected(m, W, H, seeds) {
  const out = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  seeds.forEach((p) => {
    const i = Math.round(Math.min(H - 1, Math.max(0, p.y))) * W + Math.round(Math.min(W - 1, Math.max(0, p.x)));
    if (m[i] && !out[i]) { out[i] = 1; stack[sp++] = i; }
  });
  if (!sp) return m;   // no seed landed in the mask: keep the model's mask as is
  while (sp) {
    const i = stack[--sp], x = i % W;
    if (x > 0 && m[i - 1] && !out[i - 1]) { out[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < W - 1 && m[i + 1] && !out[i + 1]) { out[i + 1] = 1; stack[sp++] = i + 1; }
    if (i >= W && m[i - W] && !out[i - W]) { out[i - W] = 1; stack[sp++] = i - W; }
    if (i < W * (H - 1) && m[i + W] && !out[i + W]) { out[i + W] = 1; stack[sp++] = i + W; }
  }
  return out;
}

// Background that can't be reached from the photo edge is a hole in the leaf
function fillHoles(m, W, H) {
  const outside = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  const push = (i) => { if (!m[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp) {
    const i = stack[--sp], x = i % W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (i >= W) push(i - W);
    if (i < W * (H - 1)) push(i + W);
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}
