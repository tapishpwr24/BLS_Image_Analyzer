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

/*
 * Field leaf finder ported from python/bls_analyzer/sam.py (segment_field), worked out on
 * the decoder's 256 grid so it stays fast on a phone:
 *   - hands = large skin-coloured regions entering from the photo edge (at most two);
 *     each gets a "not leaf" point and is cut out of the final mask
 *   - start points: leaf right next to the fingers (a held leaf), the solid leaf patch
 *     nearest the centre, and a 5 x 5 grid over the photo that needs no colour
 *     (dark, waxy or dead leaves); soil and clumps lose in the scoring
 *   - each candidate scored as in Python: confident, long, wide enough to be the leaf held
 *     close, not a sliver, reaching near the centre, mostly plant-coloured (>= 60%),
 *     little skin, and a bonus when it touches the fingers
 *   - a photo whose top third is more than 4% sky is a canopy or landscape shot: null
 * Returns { roi, score, point, points } like autoMask, { sky: true }, or null.
 * Tested on 30 BLS_SD field photos: 29 within 20% of the Python analyzer's leaf area
 * (the earlier autoMask: 21), about 2 s on top of the image encoder on a laptop.
 */
export async function fieldMask(h, imageData) {
  const W = h.W, H = h.H, px = imageData.data;
  const gw = Math.max(1, Math.round(W * h.k / 4)), gh = Math.max(1, Math.round(H * h.k / 4)), n = gw * gh;
  const sGrid = gh / H;   // grid cells per image pixel

  // sky in the top third (full resolution, as in Python)
  let sky = 0;
  for (let y = 0; y < Math.floor(H / 3); y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4, r = px[p], g = px[p + 1], b = px[p + 2];
    if (b > 140 && b > r + 25 && b >= g) sky++;
  }
  if (sky / (W * H) > 0.04) return { sky: true };   // canopy or landscape shot: no single leaf

  // colour classes sampled at each grid cell's centre
  const skin = new Uint8Array(n), leaf = new Uint8Array(n), plantT = new Uint8Array(n);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x = Math.min(W - 1, Math.floor((gx + 0.5) * W / gw)), y = Math.min(H - 1, Math.floor((gy + 0.5) * H / gh));
    const p = (y * W + x) * 4, r = px[p], g = px[p + 1], b = px[p + 2], i = gy * gw + gx;
    const Y = 0.299 * r + 0.587 * g + 0.114 * b, cr = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b, cb = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b;
    const mxI = Math.max(r, g, b), mnI = Math.min(r, g, b);
    skin[i] = r > 95 && g > 40 && b > 20 && r > g && r > b && r - g > 15 && mxI - mnI > 15 && cr >= 138 && cr <= 175 && cb >= 85 && cb <= 130 && Y > 60 ? 1 : 0;
    const rf = r / 255, gf = g / 255, bf = b / 255, mx = mxI / 255, d = (mxI - mnI) / 255, sat = mx > 0 ? d / mx : 0;
    let hue = 0;
    if (d > 0) { hue = mx === rf ? (((gf - bf) / d) % 6 + 6) % 6 : mx === gf ? (bf - rf) / d + 2 : (rf - gf) / d + 4; hue /= 6; }
    leaf[i] = d > 0 && hue >= 0.06 && hue <= 0.55 && sat >= 0.10 && mx >= 0.22 ? 1 : 0;
    plantT[i] = leaf[i] || (d > 0 && hue < 0.06 && sat >= 0.15 && mx >= 0.25) ? 1 : 0;
  }
  const it = (full) => Math.max(1, Math.round(full * sGrid));
  const minSide = Math.min(W, H);

  // hands: skin blobs reaching the edge band, at least 2% of the photo, holes filled
  let sk = gClose(gOpen(skin, gw, gh, 1), gw, gh, 1);
  const lab = gLabel(sk, gw, gh), band = Math.max(1, Math.round(Math.min(gw, gh) * 0.02));
  const edge = new Set();
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    if (gx < band || gy < band || gx >= gw - band || gy >= gh - band) { const l = lab.ids[gy * gw + gx]; if (l) edge.add(l); }
  }
  const hands = Array.from(edge).filter((l) => lab.sizes[l] >= 0.02 * n).sort((a, b) => lab.sizes[b] - lab.sizes[a]).slice(0, 2)
    .map((l) => { const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = lab.ids[i] === l ? 1 : 0; return fillHoles(m, gw, gh); });
  const handAny = new Uint8Array(n);
  hands.forEach((m) => { for (let i = 0; i < n; i++) if (m[i]) handAny[i] = 1; });
  const negs = hands.map((m) => { const p = gDeepest(m, gw, gh); return { x: (p.x + 0.5) / sGrid, y: (p.y + 0.5) / sGrid, label: 0 }; });

  // start points
  const leafNoHand = new Uint8Array(n);
  for (let i = 0; i < n; i++) leafNoHand[i] = leaf[i] && !handAny[i] ? 1 : 0;
  const solid = gErode(leafNoHand, gw, gh, it(Math.max(3, Math.round(minSide * 0.012))));
  const cands = [];
  const ringIt = it(Math.max(6, Math.round(minSide * 0.03)));
  hands.forEach((m) => {
    const dil = gDilate(m, gw, gh, ringIt), ring = [];
    for (let i = 0; i < n; i++) if (dil[i] && !m[i] && solid[i]) { const x = i % gw, y = (i - x) / gw; ring.push({ x, y, depth: Math.min(x, gw - 1 - x, y, gh - 1 - y) }); }
    if (!ring.length) return;
    ring.sort((a, b) => b.depth - a.depth);
    const step = Math.max(1, Math.floor(ring.length / 3));
    for (let j = 0, c = 0; j < ring.length && c < 3; j += step, c++) cands.push({ gx: ring[j].x, gy: ring[j].y });
  });
  let bestD = Infinity, near = null;
  for (let i = 0; i < n; i++) if (solid[i]) { const x = i % gw, y = (i - x) / gw, d = (x - gw / 2) ** 2 + (y - gh / 2) ** 2; if (d < bestD) { bestD = d; near = { gx: x, gy: y }; } }
  if (near) cands.push(near);
  const notHand = gDilate(handAny, gw, gh, it(Math.max(4, Math.round(minSide * 0.01))));
  [0.2, 0.35, 0.5, 0.65, 0.8].forEach((fy) => [0.2, 0.35, 0.5, 0.65, 0.8].forEach((fx) => {
    const gx = Math.min(gw - 1, Math.floor(gw * fx)), gy = Math.min(gh - 1, Math.floor(gh * fy));
    if (!notHand[gy * gw + gx]) cands.push({ gx, gy });
  }));
  if (!cands.length) return null;
  const pts = cands.slice(0, 30).map((c) => ({ x: (c.gx + 0.5) / sGrid, y: (c.gy + 0.5) / sGrid, gx: c.gx, gy: c.gy }));

  // one batched decoder run: each candidate = its leaf point + the hands' "not leaf" points
  const B = pts.length, P = 1 + negs.length;
  const coords = new Float32Array(B * P * 2), labels = new BigInt64Array(B * P);
  pts.forEach((p, b) => {
    [p].concat(negs).forEach((q, j) => { const o = b * P + j; coords[2 * o] = q.x * h.k; coords[2 * o + 1] = q.y * h.k; labels[o] = BigInt(j === 0 ? 1 : 0); });
  });
  const out = await sessions.dec.run({
    input_points: new ort.Tensor("float32", coords, [1, B, P, 2]),
    input_labels: new ort.Tensor("int64", labels, [1, B, P]),
    image_embeddings: h.emb,
    image_positional_embeddings: h.pos
  });
  const iouAll = out.iou_scores.data, masks = out.pred_masks.data;
  const ringAny = hands.length ? gDilate(handAny, gw, gh, ringIt) : null;
  let best = { score: 0 };
  for (let b = 0; b < B; b++) {
    let k = 0;
    for (let j = 1; j < 3; j++) if (iouAll[b * 3 + j] > iouAll[b * 3 + k]) k = j;
    const off = (b * 3 + k) * 256 * 256, iou = iouAll[b * 3 + k];
    const lo = new Uint8Array(n);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (masks[off + y * 256 + x] > 0) lo[y * gw + x] = 1;
    const seedI = pts[b].gy * gw + pts[b].gx;
    const m = lo[seedI] ? gConnected(lo, gw, gh, seedI) : lo;
    const sc = pyScore(m, gw, gh, iou, skin, plantT, ringAny, hands.length > 0);
    if (sc > best.score) best = { score: sc, off, iou, b };
  }
  if (!(best.score > 0)) return null;
  const pos = { x: pts[best.b].x, y: pts[best.b].y, label: 1, auto: true };
  const roi = finish(h, masks.subarray(best.off, best.off + 256 * 256), [pos]);
  if (hands.length) {   // a hand can still touch the mask edge
    for (let y = 0; y < H; y++) {
      const gy = Math.min(gh - 1, Math.floor(y * sGrid));
      for (let x = 0; x < W; x++) if (handAny[gy * gw + Math.min(gw - 1, Math.floor(x * gw / W))]) roi[y * W + x] = 0;
    }
  }
  return { roi, score: best.iou, point: pos, points: [pos].concat(negs.map((q) => Object.assign({ auto: true }, q))) };
}

// What the app calls: the Python-style field leaf finder first, the earlier one as a fallback;
// a canopy or landscape photo (sky) gets null, so the person is asked to mark the leaf
export async function findLeafAuto(h, imageData) {
  const f = await fieldMask(h, imageData);
  if (f && f.roi) return f;
  if (f && f.sky) return null;
  return autoMask(h, imageData);
}

function pyScore(m, gw, gh, iou, skin, plantT, ringAny, hasHand) {
  const n = gw * gh;
  let N = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sk = 0, pl = 0, dmin = 9, touch = false;
  for (let i = 0; i < n; i++) {
    if (!m[i]) continue;
    const x = i % gw, y = (i - x) / gw;
    N++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sk += skin[i]; pl += plantT[i];
    const dc = Math.hypot((y - gh / 2) / gh, (x - gw / 2) / gw);
    if (dc < dmin) dmin = dc;
    if (ringAny && ringAny[i]) touch = true;
  }
  const frac = N / n;
  if (frac < 0.01 || frac > tuning.maxArea || N < 10) return 0;
  if (pl / N < 0.6) return 0;                                   // board, soil, clothes, sky
  const mx = sx / N, my = sy / N;
  const cxx = sxx / N - mx * mx, cyy = syy / N - my * my, cxy = sxy / N - mx * my;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-9, tr / 2 - disc);
  const elong = Math.sqrt(l1 / l2), width = 4 * Math.sqrt(l2) / Math.min(gh, gw), skinIn = sk / N;
  let s = iou * iou * Math.min(elong, 10) / 10 * (1 - skinIn) * (1 - skinIn);
  s *= Math.min(1, width / 0.06);                               // thin stems and blades score low
  s *= Math.min(1, Math.sqrt(frac / 0.04));
  s *= Math.exp(-4 * dmin);                                     // the leaf shown is near the centre
  if (hasHand && touch) s *= 1.5;                               // a held leaf touches the fingers
  return s;
}

// small grid helpers (4-connected)
function gErode(m, w, h, it) { for (let t = 0; t < it; t++) { const o = new Uint8Array(m.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; o[i] = m[i] && x > 0 && m[i - 1] && x < w - 1 && m[i + 1] && y > 0 && m[i - w] && y < h - 1 && m[i + w] ? 1 : 0; } m = o; } return m; }
function gDilate(m, w, h, it) { for (let t = 0; t < it; t++) { const o = new Uint8Array(m.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; o[i] = m[i] || (x > 0 && m[i - 1]) || (x < w - 1 && m[i + 1]) || (y > 0 && m[i - w]) || (y < h - 1 && m[i + w]) ? 1 : 0; } m = o; } return m; }
function gOpen(m, w, h, it) { return gDilate(gErode(m, w, h, it), w, h, it); }
function gClose(m, w, h, it) { return gErode(gDilate(m, w, h, it), w, h, it); }
function gLabel(m, w, h) {
  const n = m.length, ids = new Int32Array(n), stack = new Int32Array(n), sizes = [0]; let k = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (!m[s0] || ids[s0]) continue;
    k++; let sp = 0, size = 0; stack[sp++] = s0; ids[s0] = k;
    while (sp) {
      const i = stack[--sp], x = i % w; size++;
      if (x > 0 && m[i - 1] && !ids[i - 1]) { ids[i - 1] = k; stack[sp++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !ids[i + 1]) { ids[i + 1] = k; stack[sp++] = i + 1; }
      if (i >= w && m[i - w] && !ids[i - w]) { ids[i - w] = k; stack[sp++] = i - w; }
      if (i < n - w && m[i + w] && !ids[i + w]) { ids[i + w] = k; stack[sp++] = i + w; }
    }
    sizes.push(size);
  }
  return { ids, sizes };
}
function gConnected(m, w, h, seed) {
  const n = m.length, out = new Uint8Array(n), stack = new Int32Array(n); let sp = 0;
  out[seed] = 1; stack[sp++] = seed;
  while (sp) {
    const i = stack[--sp], x = i % w;
    if (x > 0 && m[i - 1] && !out[i - 1]) { out[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < w - 1 && m[i + 1] && !out[i + 1]) { out[i + 1] = 1; stack[sp++] = i + 1; }
    if (i >= w && m[i - w] && !out[i - w]) { out[i - w] = 1; stack[sp++] = i - w; }
    if (i < n - w && m[i + w] && !out[i + w]) { out[i + w] = 1; stack[sp++] = i + w; }
  }
  return out;
}
// the point deepest inside a mask (two-pass chamfer distance)
function gDeepest(m, w, h) {
  const n = m.length, d = new Float32Array(n), INF = 1e9;
  for (let i = 0; i < n; i++) d[i] = m[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!d[i]) continue; let v = d[i]; if (x > 0) v = Math.min(v, d[i - 1] + 1); else v = Math.min(v, 1); if (y > 0) v = Math.min(v, d[i - w] + 1); else v = Math.min(v, 1); d[i] = v; }
  let best = 0, bi = 0;
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { const i = y * w + x; if (!d[i]) continue; let v = d[i]; if (x < w - 1) v = Math.min(v, d[i + 1] + 1); else v = Math.min(v, 1); if (y < h - 1) v = Math.min(v, d[i + w] + 1); else v = Math.min(v, 1); d[i] = v; if (v > best) { best = v; bi = i; } }
  return { x: bi % w, y: Math.floor(bi / w) };
}

// Limits for a candidate leaf region (tested on BLS_SD field photos against the Python analyzer)
// maxArea 0.45 stops a board or background strip being taken as the leaf (BLS_SD_87.3: 47% -> 4%).
// minPlant is a mild safety net: the app's plant colour test misses shaded leaves, so 0.5 or more
// rejected real leaves on IMG_4828, 421-1 and 408; 0.3 rejects only regions that are mostly board or sky.
export const tuning = { minPlant: 0.3, maxArea: 0.45, scoring: "app" };

function leafiness(masks, off, gw, gh, plant, skin, iou) {
  const n = gw * gh, lo = new Uint8Array(n);
  let area = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (masks[off + y * 256 + x] > 0) { lo[y * gw + x] = 1; area++; }
  const fa = area / n;
  // a single leaf never fills half the photo (as in the Python analyzer: at most 45%)
  if (fa < 0.01 || fa > tuning.maxArea) return { score: -1, skinFrac: 1, area: fa };
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
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, pl = 0, sk = 0, dmin = 9;
  for (let i = 0; i < n; i++) {
    if (ids[i] !== bestId) continue;
    const x = i % gw, y = (i - x) / gw;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; pl += plant[i]; sk += skin[i];
    const dc = Math.hypot(y / gh - 0.5, x / gw - 0.5);   // how close the region comes to the centre
    if (dc < dmin) dmin = dc;
  }
  const N = bestSize, mx = sx / N, my = sy / N;
  const cxx = sxx / N - mx * mx, cyy = syy / N - my * my, cxy = sxy / N - mx * my;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  const elong = Math.sqrt(l1 / l2);
  const plantFrac = pl / N;
  const cent = 1 - Math.min(1, 2 * Math.hypot(mx / gw - 0.5, my / gh - 0.5));
  const skinFrac = sk / N;
  // A board, paper or sky strip can be long and thin too: a leaf region must be mostly
  // plant-coloured (green, yellow, tan or brown lesions), as in the Python analyzer
  if (plantFrac < tuning.minPlant) return { score: -1, skinFrac: skinFrac, area: fa };
  let score;
  if (tuning.scoring === "python") {
    // As python/bls_analyzer/sam.py: a whole leaf held near the camera beats a narrow strip of
    // it — wide enough (width term), not a sliver (area term), reaching near the centre
    const width = 4 * Math.sqrt(l2) / Math.min(gh, gw);
    score = iou * iou * Math.min(elong, 10) / 10 * Math.pow(Math.max(0, 1 - skinFrac), 2) *
      Math.min(1, width / 0.06) * Math.min(1, Math.sqrt(fa / 0.04)) * Math.exp(-4 * dmin);
  } else {
    score = iou * Math.min(elong, 8) / 8 * plantFrac * (0.4 + 0.6 * cent) * (fa > 0.02 ? 1 : 0.5) * Math.max(0, 1 - 3 * skinFrac);
  }
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
