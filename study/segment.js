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
 *   const auto = await seg.autoMask(handle, imageData);     // no taps: picks the leaf itself
 *   const fix  = await seg.mask(handle, [{x, y, label: 1}]); // with taps (1 = leaf, 0 = not leaf)
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

// Download with progress so the first use can show "Downloading leaf finder… 40%".
// Chunks are collected and joined at the end: the server's content-length can be
// the *compressed* size (GitHub Pages gzips files), so it can't size the buffer.
async function fetchBytes(url, onBytes, expected) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not download the leaf finder (" + res.status + ")");
  if (!res.body || !res.body.getReader) {
    const b = new Uint8Array(await res.arrayBuffer());
    onBytes(b.length, b.length);
    return b;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes(Math.min(got, expected), expected);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export function isLoaded() { return !!sessions; }
export function threads() { return ort ? ort.env.wasm.numThreads : 0; }

export function load(onProgress) {
  if (sessions) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    ort = await import(ORT_DIR + "ort.wasm.min.mjs");
    ort.env.wasm.wasmPaths = ORT_DIR;
    // Threads need a cross-origin isolated page; otherwise run single-threaded.
    // After a failure the app sets bls-sam-threads=1 so the next try is single-threaded.
    let single = false;
    try { single = localStorage.getItem("bls-sam-threads") === "1"; } catch (e) { /* ignore */ }
    ort.env.wasm.numThreads = self.crossOriginIsolated && !single ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    const sizes = [8882165, 4903810];  // encoder, decoder (for a smooth progress bar)
    const done = [0, 0];
    const report = () => onProgress && onProgress((done[0] + done[1]) / (sizes[0] + sizes[1]));
    const [encBytes, decBytes] = await Promise.all([
      fetchBytes(MODEL_DIR + "vision_encoder_quantized.onnx", (g) => { done[0] = g; report(); }, sizes[0]),
      fetchBytes(MODEL_DIR + "prompt_encoder_mask_decoder_quantized.onnx", (g) => { done[1] = g; report(); }, sizes[1])
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
  const seeds = points.filter((p) => p.label === 1);
  return { roi: finish(h, logits, seeds), score: iou[best] };
}

// 256x256 low-res logits cover the padded 1024 square: bilinear upsample to the
// image, keep the part connected to the leaf point(s), fill lesion holes
function finish(h, logits, seeds) {
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
  return fillHoles(keepConnected(m, W, H, seeds), W, H);
}

/*
 * Fully automatic: try a 5x5 grid of starting points over the middle of the
 * photo (only those on plant-coloured pixels), in ONE batched decoder run,
 * and keep the most leaf-like mask: long and narrow, plant-coloured, near the
 * centre, confident, and neither tiny nor most of the photo.
 */
export async function autoMask(h, imageData) {
  const gw = Math.max(1, Math.round(h.W * h.k / 4)), gh = Math.max(1, Math.round(h.H * h.k / 4));
  const src = document.createElement("canvas");
  src.width = imageData.width; src.height = imageData.height;
  src.getContext("2d").putImageData(imageData, 0, 0);
  const c = document.createElement("canvas");
  c.width = gw; c.height = gh;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(src, 0, 0, gw, gh);
  const px = cx.getImageData(0, 0, gw, gh).data;
  const plant = new Uint8Array(gw * gh), skin = new Uint8Array(gw * gh);
  for (let i = 0, p = 0; i < plant.length; i++, p += 4) {
    const r = px[p] / 255, g = px[p + 1] / 255, b = px[p + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, sat = max ? d / max : 0;
    let hue = 0;
    if (d > 0) { hue = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d; hue /= 6; if (hue < 0) hue += 1; }
    // Hands: reddish (hue 0-32 deg) with red clearly above green; leaf brown/tan is yellower
    skin[i] = max > 0.3 && sat > 0.15 && sat < 0.7 && (hue < 30 / 360 || hue > 345 / 360) && (r - g) / r >= 0.19 ? 1 : 0;
    plant[i] = !skin[i] && max > 0.2 && sat > 0.2 && (hue < 0.5 || hue > 0.95) ? 1 : 0;
  }
  const pts = [];
  for (let gy = 0.3; gy <= 0.701; gy += 0.1) {
    for (let gx = 0.3; gx <= 0.701; gx += 0.1) {
      if (plant[Math.floor(gy * gh) * gw + Math.floor(gx * gw)]) pts.push({ x: gx * h.W, y: gy * h.H });
    }
  }
  if (!pts.length) pts.push({ x: h.W / 2, y: h.H / 2 });
  const B = pts.length;
  const coords = new Float32Array(B * 2);
  pts.forEach((p, i) => { coords[2 * i] = p.x * h.k; coords[2 * i + 1] = p.y * h.k; });
  const out = await sessions.dec.run({
    input_points: new ort.Tensor("float32", coords, [1, B, 1, 2]),
    input_labels: new ort.Tensor("int64", new BigInt64Array(B).fill(1n), [1, B, 1]),
    image_embeddings: h.emb,
    image_positional_embeddings: h.pos
  });
  const iou = out.iou_scores.data, masks = out.pred_masks.data;
  let best = { score: -1 };
  for (let b = 0; b < B; b++) {
    for (let k = 0; k < 3; k++) {
      const off = (b * 3 + k) * 256 * 256;
      const sc = leafiness(masks, off, gw, gh, plant, skin, iou[b * 3 + k]);
      if (sc.score > best.score) best = { score: sc.score, skinFrac: sc.skinFrac, area: sc.area, off, point: pts[b], iou: iou[b * 3 + k] };
    }
  }
  if (best.score < 0) return null;   // nothing leaf-like found
  let logits = masks.subarray(best.off, best.off + 256 * 256);
  const pos = { x: best.point.x, y: best.point.y, label: 1, auto: true };
  let points = [pos];

  // A hand still inside the leaf mask: re-run with "not leaf" points on the skin
  if (best.skinFrac > 0.005) {
    const negs = skinPoints(masks, best.off, gw, gh, skin, h);
    if (negs.length) {
      const all = [pos].concat(negs);
      const c2 = new Float32Array(all.length * 2), l2 = new BigInt64Array(all.length);
      all.forEach((p, i) => { c2[2 * i] = p.x * h.k; c2[2 * i + 1] = p.y * h.k; l2[i] = BigInt(p.label); });
      const o2 = await sessions.dec.run({
        input_points: new ort.Tensor("float32", c2, [1, 1, all.length, 2]),
        input_labels: new ort.Tensor("int64", l2, [1, 1, all.length]),
        image_embeddings: h.emb,
        image_positional_embeddings: h.pos
      });
      let b2 = null;
      for (let k = 0; k < 3; k++) {
        const sc = leafiness(o2.pred_masks.data, k * 256 * 256, gw, gh, plant, skin, o2.iou_scores.data[k]);
        if (sc.score > 0 && sc.skinFrac < best.skinFrac && sc.area > 0.5 * best.area && (!b2 || sc.score > b2.score)) b2 = { score: sc.score, k };
      }
      if (b2) {
        logits = o2.pred_masks.data.subarray(b2.k * 256 * 256, (b2.k + 1) * 256 * 256);
        points = all.map((p) => Object.assign({ auto: true }, p));
      }
    }
  }
  return { roi: finish(h, logits, [pos]), score: best.iou, point: pos, points: points };
}

// Centres of the largest skin patches touching the chosen mask (up to 3)
function skinPoints(masks, off, gw, gh, skin, h) {
  const n = gw * gh, seen = new Uint8Array(n), stack = new Int32Array(n), blobs = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (!skin[s0] || seen[s0]) continue;
    let sp = 0, size = 0, sx = 0, sy = 0, inMask = 0;
    stack[sp++] = s0; seen[s0] = 1;
    while (sp) {
      const i = stack[--sp], x = i % gw, y = (i - x) / gw;
      size++; sx += x; sy += y;
      if (masks[off + y * 256 + x] > 0) inMask++;
      if (x > 0 && skin[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < gw - 1 && skin[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (i >= gw && skin[i - gw] && !seen[i - gw]) { seen[i - gw] = 1; stack[sp++] = i - gw; }
      if (i < n - gw && skin[i + gw] && !seen[i + gw]) { seen[i + gw] = 1; stack[sp++] = i + gw; }
    }
    if (size >= 0.01 * n && inMask) blobs.push({ size, x: sx / size, y: sy / size });
  }
  blobs.sort((a, b) => b.size - a.size);
  // grid -> image pixels: grid cell = 4 px in the 1024 frame
  return blobs.slice(0, 3).map((b) => ({ x: (b.x + 0.5) * 4 / h.k, y: (b.y + 0.5) * 4 / h.k, label: 0 }));
}

function leafiness(masks, off, gw, gh, plant, skin, iou) {
  const n = gw * gh, lo = new Uint8Array(n);
  let area = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (masks[off + y * 256 + x] > 0) { lo[y * gw + x] = 1; area++; }
  const fa = area / n;
  if (fa < 0.01 || fa > 0.6) return { score: -1, skinFrac: 1, area: fa };
  // largest connected part
  const ids = new Int32Array(n), stack = new Int32Array(n);
  let bestId = 0, bestSize = 0, id = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (!lo[s0] || ids[s0]) continue;
    id++; let sp = 0, size = 0; stack[sp++] = s0; ids[s0] = id;
    while (sp) {
      const i = stack[--sp], x = i % gw; size++;
      if (x > 0 && lo[i - 1] && !ids[i - 1]) { ids[i - 1] = id; stack[sp++] = i - 1; }
      if (x < gw - 1 && lo[i + 1] && !ids[i + 1]) { ids[i + 1] = id; stack[sp++] = i + 1; }
      if (i >= gw && lo[i - gw] && !ids[i - gw]) { ids[i - gw] = id; stack[sp++] = i - gw; }
      if (i < n - gw && lo[i + gw] && !ids[i + gw]) { ids[i + gw] = id; stack[sp++] = i + gw; }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
  }
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, pl = 0, sk = 0;
  for (let i = 0; i < n; i++) {
    if (ids[i] !== bestId) continue;
    const x = i % gw, y = (i - x) / gw;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; pl += plant[i]; sk += skin[i];
  }
  const N = bestSize, mx = sx / N, my = sy / N;
  const cxx = sxx / N - mx * mx, cyy = syy / N - my * my, cxy = sxy / N - mx * my;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  const elong = Math.sqrt(l1 / l2);
  const plantFrac = pl / N;
  const cent = 1 - Math.min(1, 2 * Math.hypot(mx / gw - 0.5, my / gh - 0.5));
  const skinFrac = sk / N;
  const score = iou * Math.min(elong, 8) / 8 * plantFrac * (0.4 + 0.6 * cent) * (fa > 0.02 ? 1 : 0.5) * Math.max(0, 1 - 3 * skinFrac);
  return { score, skinFrac, area: fa };
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
