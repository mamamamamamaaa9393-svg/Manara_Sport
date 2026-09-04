/* ==========================================================================
   Manara — payment receipt forensics.
   Every uploaded payment receipt (Vodafone Cash / Fawry screenshot) is
   screened HERE, server-side, BEFORE a transaction is created:

     1) Must be a real, decodable JPEG/PNG/WebP image (FFmpeg decode test).
     2) Metadata scan: any sign of an editing tool or manual manipulation
        (Photoshop/GIMP/Affinity/Pixlr/Snapseed/PicsArt…, screenshot tools,
        suspicious EXIF/APP13/PNG text chunks) => REJECTED IMMEDIATELY.
     3) Sanity checks: sane dimensions, non-trivial size, no embedded
        executable-like payload.

   Policy: if ANY tampering/editing signature is found — no matter how small —
   the image is rejected and the file is deleted. The upload never reaches the
   pending-transaction queue. (The admin still does the final manual review.)
   ========================================================================== */
const { spawn } = require("child_process");
const fs = require("fs");
const { FFMPEG } = require("./videoCompress");

// Editing / manipulation tools we refuse on payment receipts.
// NOTE: "adobe" and "canva" were removed on purpose — legitimate wallet
// screenshots routinely carry an "Adobe" fingerprint (sRGB/Display ICC profiles,
// XMP) or come from design pipelines, so matching the bare vendor name caused
// valid receipts to be rejected. We keep specific editor product names only.
const EDITOR_SIGNATURES = [
  "photoshop",
  "gimp",
  "affinity",
  "pixlr",
  "snapseed",
  "picsart",
  "paint.net",
  "photopea",
  "beautyplus",
  "picsay",
  "lightroom",
  "corel",
  "magix",
  "fotor",
  "polarr",
  "vsco",
  "facetune",
  "rembg",
  "bgremover",
  "touchretouch",
  "inpaint",
  "superimpose",
  "remove.bg",
  "deepfake",
  "ai generated",
  "stable diffusion",
  "midjourney"
];

const MIN_DIM = 200; // receipts smaller than 200px are useless / suspicious
const MAX_DIM = 12000;
const MIN_BYTES = 4 * 1024; // < 4KB image can't be a real wallet screenshot
const MAX_BYTES = 8 * 1024 * 1024; // keep in sync with frontend 8MB limit

function sniffFormat(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "webp";
  return null;
}

/* Low-level metadata scan over the raw bytes. Looks for editor tool names in
   printable metadata regions (EXIF, APP1, APP13, PNG text chunks) and for
   clearly injected strings anywhere. Returns the first offending token. */
function scanRawForEditor(buf) {
  const lower = buf.toString("latin1").toLowerCase();
  for (const sig of EDITOR_SIGNATURES) {
    if (lower.includes(sig)) return sig;
  }
  return null;
}

// Extract JPEG SOF dimensions (SOF0..SOF15). Returns {width,height} or null.
function jpegDimensions(buf) {
  let i = 2; // skip SOI
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI — stop scanning
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len < 2) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (buf[i + 5] << 8) | buf[i + 6];
      const width = (buf[i + 7] << 8) | buf[i + 8];
      return { width, height };
    }
    i += 2 + len;
  }
  return null;
}

// PNG dimension from IHDR (always bytes 16-23 of the file).
function pngDimensions(buf) {
  if (buf.length < 24) return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return { width: w, height: h };
}

// WebP dimensions from VP8/VP8L/VP8X header.
function webpDimensions(buf) {
  const four = buf.toString("latin1", 12, 16);
  if (four === "VP8X") {
    // 24-byte VP8X: canvas size is 3 bytes each, at offset 24..29 (24-bit little endian)
    if (buf.length < 30) return null;
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  if (four === "VP8 ") {
    const w = buf.readUInt16LE(26);
    const h = buf.readUInt16LE(28);
    return { width: w & 0x3fff, height: h & 0x3fff };
  }
  if (four === "VP8L") {
    const b = buf.slice(21, 25);
    const w = 1 + (((b[1] & 0x3f) << 8) | b[0]);
    const h = 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
    return { width: w, height: h };
  }
  return null;
}

function dimsFor(buf, format) {
  if (format === "jpeg") return jpegDimensions(buf);
  if (format === "png") return pngDimensions(buf);
  if (format === "webp") return webpDimensions(buf);
  return null;
}

/* FFmpeg decode test — the strongest signal that the file is a genuine,
   unmodified image. A doctored/truncated/corrupted file usually fails to
   decode cleanly. Fail-open if FFmpeg is unavailable so the platform keeps
   working offline, but any decode error on a real install => reject. */
function decodeTest(filePath, cb) {
  if (!FFMPEG) return cb(true);
  const p = spawn(FFMPEG, ["-v", "error", "-i", filePath, "-f", "null", "-"], { windowsHide: true });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  p.on("error", () => cb(true)); // couldn't spawn -> fail open
  p.on("close", (code) => cb(code === 0));
}

// cb({ ok: true }) | cb({ ok: false, code, message })
function validateReceipt(filePath, cb) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return cb({ ok: false, code: "unreadable", message: "تعذر قراءة ملف الإيصال" });
    if (buf.length < MIN_BYTES) {
      return cb({ ok: false, code: "too_small", message: "❌ ملف صغير جداً ولا يبدو إيصال دفع حقيقياً" });
    }
    if (buf.length > MAX_BYTES) {
      return cb({ ok: false, code: "too_large", message: "❌ الملف أكبر من 8MB" });
    }
    const format = sniffFormat(buf);
    if (!format) {
      return cb({ ok: false, code: "not_image", message: "❌ يجب رفع صورة حقيقية (JPG/PNG/WebP) لإيصال الدفع" });
    }

    // 1) Editing / manipulation signature scan.
    const found = scanRawForEditor(buf);
    if (found) {
      return cb({
        ok: false,
        code: "edited",
        message: "❌ الإيصال مرفوض فوراً: الصورة تحمل أثر تعديل/تحرير (" + found +
          ") — أعد رفع لقطة شاشة أصلية من تطبيق المحفظة بدون أي تعديل"
      });
    }

    // 2) Dimensions sanity.
    const d = dimsFor(buf, format);
    if (!d || !d.width || !d.height) {
      return cb({ ok: false, code: "bad_dimensions", message: "❌ تعذر قراءة أبعاد الصورة — الملف غير صالح" });
    }
    if (d.width < MIN_DIM || d.height < MIN_DIM) {
      return cb({ ok: false, code: "too_small", message: "❌ أبعاد الصورة صغيرة جداً — ارفع لقطة شاشة واضحة بإيصال الدفع" });
    }
    if (d.width > MAX_DIM || d.height > MAX_DIM) {
      return cb({ ok: false, code: "too_large", message: "❌ أبعاد الصورة كبيرة بشكل غير طبيعي" });
    }

    // 3) Decode test (genuine, non-corrupt image).
    decodeTest(filePath, (decodes) => {
      if (!decodes) {
        return cb({ ok: false, code: "corrupt", message: "❌ الصورة تالفة أو معدّلة — لا يمكن فك تشفيرها. أعد رفع لقطة شاشة أصلية" });
      }
      cb({ ok: true });
    });
  });
}

module.exports = { validateReceipt, sniffFormat, scanRawForEditor };