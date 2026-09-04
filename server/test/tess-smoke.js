/* Quick smoke test: load tesseract with ara+eng and recognize a tiny image. */
const path = require("path");
const { createWorker } = require("tesseract.js");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");

const dir = path.join(os.tmpdir(), "tess_smoke_" + Date.now());
fs.mkdirSync(dir, { recursive: true });
const img = path.join(dir, "t.png");

// Create a 400x100 PNG with black text on white using pure JS (solid fill + digits).
// We'll just render digits "12345" in a blocky font approximation.
function makeImg() {
  const w = 400, h = 100, ch = 4, stride = w * ch;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (stride + 1) + 1 + x * ch;
      const dark = (x > 60 && x < 200 && y > 30 && y < 70);
      const v = dark ? 0 : 255;
      raw[o] = v; raw[o + 1] = v; raw[o + 2] = v; raw[o + 3] = 255;
    }
  }
  const zlib = require("zlib");
  function chunk(type, data) {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    let c = 0xffffffff;
    const crcT = [];
    for (let n = 0; n < 256; n++) { let cc = n; for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1; crcT[n] = cc >>> 0; }
    for (const b of Buffer.concat([t, data])) c = crcT[(c ^ b) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))
  ]);
  fs.writeFileSync(img, png);
}
makeImg();

(async () => {
  console.log("creating worker with ara+eng...");
  const worker = await createWorker("ara+eng");
  console.log("worker ready, recognizing...");
  const { data } = await worker.recognize(img);
  console.log("confidence:", data.confidence);
  console.log("text:", JSON.stringify(data.text.slice(0, 120)));
  await worker.terminate();
  console.log("SMOKE OK");
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAIL:", e && e.message);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});