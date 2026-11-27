/*
 * Checks that app/engine.js reproduces the R pipeline.
 * Decodes example_data/*.JPEG in headless Chromium (as the phone browser
 * does), runs the JS engine, and compares with example_output/BLS_results.csv.
 *
 *   node tools/verify_engine.js
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const engineSrc = fs.readFileSync(path.join(ROOT, "app/engine.js"), "utf8");

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const head = lines[0].split(",").map((s) => s.replace(/"/g, ""));
  return lines.slice(1).map((l) => {
    const cells = l.split(",").map((s) => s.replace(/"/g, ""));
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}

(async () => {
  const expected = readCsv(path.join(ROOT, "example_output/BLS_results.csv"));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  await page.addScriptTag({ content: engineSrc });

  let failures = 0;
  for (const row of expected) {
    const file = path.join(ROOT, "example_data", row.Image_File);
    const b64 = fs.readFileSync(file).toString("base64");
    const r = await page.evaluate(async (b64) => {
      const blob = await (await fetch("data:image/jpeg;base64," + b64)).blob();
      // imageOrientation "none" matches magick::image_read (no auto-rotate)
      const bmp = await createImageBitmap(blob, { imageOrientation: "none" });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
      const res = BLSEngine.analyze(d.data, d.width, d.height, undefined, undefined, "r1");
      delete res.mask;
      return res;
    }, b64);

    const checks = [
      ["Leaf_Pixels", r.leafPixels, +row.Leaf_Pixels, 0.002],
      ["Necrotic_Pixels", r.necroticPixels, +row.Necrotic_Pixels, 0.01],
      ["Chlorotic_Pixels", r.chloroticPixels, +row.Chlorotic_Pixels, 0.01],
      ["Total_Diseased_Percent", r.diseasedPct, +row.Total_Diseased_Percent, 0.05, true],
      ["BLS_Score", r.score, +row.BLS_Score, 0, true]
    ];
    console.log(`\n${row.Image_File}  (${r.width} x ${r.height})`);
    for (const [name, got, want, tol, absolute] of checks) {
      const diff = Math.abs(got - want);
      const ok = absolute ? diff <= tol : diff <= Math.max(1, want * tol);
      if (!ok) failures++;
      console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(24)} R=${want}  JS=${got}`);
    }
    console.log(`       Category: ${r.category}   QC: ${r.qc}`);
  }
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})();
