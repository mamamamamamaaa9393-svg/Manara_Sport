// Automatic background compression of uploaded photos using FFmpeg.
// Runs AFTER the HTTP response is sent: the original file is kept until the
// compressed copy is ready, then swapped in-place under the same filename, so
// existing URLs keep working. If compression fails or the result is not
// smaller, the original file stays intact. Payment receipts are NEVER
// compressed (pixel forensics must stay untouched) — the caller decides.
const path = require("path");
const fs = require("fs");
const { FFMPEG, FFPROBE } = require("./videoCompress");

const MIN_COMPRESS_BYTES = 300 * 1024; // skip tiny files
const MAX_DIM = 1600; // cap the longest side (photos stay sharp on phones)
const SKIP_DIM = 1200; // already smaller than this -> skip
const JPEG_Q = "3"; // ffmpeg -q:v scale (lower = better, 2-5 is a good range)

let queue = [];
let busy = false;

function log(msg) {
  try { console.log("[img-compress] " + msg); } catch (e) {}
}

function probeImage(filePath, cb) {
  const ffprobe = FFPROBE;
  if (!ffprobe) return cb(null);
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-show_entries", "format=size",
    "-of", "json",
    filePath
  ];
  let out = "";
  const p = require("child_process").spawn(ffprobe, args, { windowsHide: true });
  p.stdout.on("data", (d) => (out += d));
  p.on("error", () => cb(null));
  p.on("close", (code) => {
    if (code !== 0) return cb(null);
    try {
      const j = JSON.parse(out);
      const s = j.streams && j.streams[0];
      cb({
        width: +(s && s.width) || 0,
        height: +(s && s.height) || 0,
        size: +(j.format && j.format.size) || 0
      });
    } catch (e) {
      cb(null);
    }
  });
}

function compressImage(filePath, tmpOut, mime, cb) {
  const vf = "scale='min(" + MAX_DIM + ",iw)':'min(" + MAX_DIM + ",ih)':force_original_aspect_ratio=decrease";
  const args = ["-y", "-i", filePath, "-vf", vf, "-threads", "2"];
  if (/jpe?g/i.test(mime)) args.push("-q:v", JPEG_Q);
  else if (/png/i.test(mime)) args.push("-compression_level", "6");
  else if (/webp/i.test(mime)) args.push("-q:v", "75");
  else return cb(false); // gif / unknown: leave untouched
  args.push(tmpOut);

  const p = require("child_process").spawn(FFMPEG, args, { windowsHide: true });
  let errLog = "";
  p.stderr.on("data", (d) => { if (errLog.length < 2000) errLog += d; });
  p.on("error", (e) => { log("ffmpeg spawn error: " + e.message); cb(false); });
  p.on("close", (code) => {
    if (code !== 0) {
      log("ffmpeg failed (" + code + "): " + errLog.slice(-300).replace(/\s+/g, " ").trim());
      cb(false);
    } else {
      cb(true);
    }
  });
}

function processFile(filePath, mime) {
  fs.stat(filePath, (err, st) => {
    if (err || !st || st.size < MIN_COMPRESS_BYTES) return done();
    probeImage(filePath, (meta) => {
      if (!meta) return done();
      if (meta.width && meta.height && meta.width <= SKIP_DIM && meta.height <= SKIP_DIM) return done();
      const ext = /png/i.test(mime) ? ".png" : (/webp/i.test(mime) ? ".webp" : ".jpg");
      const tmpOut = filePath + ".tmp" + process.pid + ext;
      compressImage(filePath, tmpOut, mime, (ok) => {
        if (!ok) { try { fs.unlinkSync(tmpOut); } catch (e) {} return done(); }
        let smaller = false;
        try { smaller = fs.statSync(tmpOut).size < fs.statSync(filePath).size; } catch (e) {}
        if (!smaller) { try { fs.unlinkSync(tmpOut); } catch (e) {} return done(); }
        // Swap in place under the same filename (retry on transient locks).
        let attempts = 0;
        const trySwap = () => {
          try {
            fs.renameSync(tmpOut, filePath);
            done();
          } catch (e) {
            if (attempts++ < 5) { setTimeout(trySwap, 400); }
            else { try { fs.unlinkSync(tmpOut); } catch (e2) {} done(); }
          }
        };
        trySwap();
      });
    });
  });
}

function done() {
  busy = false;
  if (queue.length) {
    const next = queue.shift();
    busy = true;
    setImmediate(() => processFile(next.path, next.mime));
  }
}

function enqueueImageCompress(filePath, mime) {
  if (!FFMPEG) return;
  if (busy) { queue.push({ path: filePath, mime: mime }); return; }
  busy = true;
  setImmediate(() => processFile(filePath, mime));
}

module.exports = { enqueueImageCompress, FFMPEG };