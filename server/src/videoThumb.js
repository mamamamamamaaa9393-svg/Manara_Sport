// Automatic poster/thumbnail generation for uploaded videos using FFmpeg.
// Extracts a single JPEG frame (~2s in, or ~10% for very long clips) as
// <video-basename>.jpg right next to the video. The URL is deterministic
// (video /uploads/x.mp4  ->  thumbnail /uploads/x.jpg), so the frontend just
// appends the poster. If anything fails the video is left untouched.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const pool = require("./ffmpegPool");

// Releases the ffmpeg-pool slot held by the running job, if any. Module-level
// because this module is strictly single-flight: at most one job holds a slot.
let releaseSlot = null;

function findFfmpeg() {
  const gyan = path.join(
    process.env.LOCALAPPDATA || "",
    "Programs",
    "ffmpeg",
    "ffmpeg-9.0.1-essentials_build",
    "bin",
    "ffmpeg.exe"
  );
  try {
    if (fs.existsSync(gyan)) return gyan;
  } catch (e) {}
  return "ffmpeg";
}

const FFMPEG = process.env.FFMPEG_PATH || findFfmpeg();
const ENABLED = !!FFMPEG;
const THUMB_W = 640; // keep network + storage light
const MIN_VIDEO_BYTES = 200 * 1024; // skip tiny test clips

let queue = [];
let busy = false;

const PROBE_TIMEOUT_MS = 30000;
const THUMB_TIMEOUT_MS = 180000; // 3 min for a single-frame extract

function log(msg) {
  try { console.log("[video-thumb] " + msg); } catch (e) {}
}

// Hard timeout guard: kill a stuck child so the single-flight queue never dies.
function killAfter(p, ms, onTimeout) {
  const t = setTimeout(() => {
    try { p.kill("SIGKILL"); } catch (e) {}
    onTimeout();
  }, ms);
  p.on("close", () => clearTimeout(t));
  p.on("error", () => clearTimeout(t));
  return t;
}

function probeDuration(filePath, cb) {
  const ffprobe = FFMPEG ? FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1") : null;
  if (!ffprobe) return cb(2);
  let out = "";
  let done = false;
  const finish = (d) => { if (done) return; done = true; clearTimeout(timer); cb(d); };
  const p = spawn(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath
  ], { windowsHide: true });
  p.stdout.on("data", (d) => { if (out.length < 4096) out += d; });
  p.on("error", () => finish(2));
  p.on("close", (code) => {
    if (code !== 0) return finish(2);
    try {
      const j = JSON.parse(out);
      const d = +(j.format && j.format.duration) || 0;
      finish(d > 0 ? d : 2);
    } catch (e) { finish(2); }
  });
  const timer = killAfter(p, PROBE_TIMEOUT_MS, () => {
    log("ffprobe timed out — killed: " + filePath);
    finish(2);
  });
}

function makeThumb(filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st || st.size < MIN_VIDEO_BYTES) return done();
    const thumbPath = filePath.replace(/\.[^/.]+$/, "") + ".jpg";
    probeDuration(filePath, (duration) => {
      const seek = Math.min(duration, Math.max(1.5, duration * 0.1));
      const tmpOut = thumbPath + ".tmp" + process.pid + ".jpg";
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearTimeout(timer); done(); };
      const p = spawn(FFMPEG, [
        "-y", "-ss", String(seek),
        "-i", filePath,
        "-frames:v", "1",
        "-vf", "scale='" + THUMB_W + "':-2",
        "-q:v", "4",
        "-threads", "1",
        tmpOut
      ], { windowsHide: true });
      let errLog = "";
      p.stderr.on("data", (d) => {
        if (errLog.length < 1200) errLog += d;
      });
      p.on("error", () => finish());
      p.on("close", (code) => {
        if (code !== 0) {
          try { fs.unlinkSync(tmpOut); } catch (e) {}
          log("extract failed (" + code + "): " + errLog.slice(-200).replace(/\s+/g, " ").trim());
          return finish();
        }
        // Replace any existing thumbnail in place.
        try { fs.renameSync(tmpOut, thumbPath); } catch (e) {
          try { fs.copyFileSync(tmpOut, thumbPath); } catch (e2) {}
          try { fs.unlinkSync(tmpOut); } catch (e3) {}
        }
        finish();
      });
      const timer = killAfter(p, THUMB_TIMEOUT_MS, () => {
        log("thumbnail ffmpeg timed out — killed: " + filePath);
        try { fs.unlinkSync(tmpOut); } catch (e) {}
        finish();
      });
    });
  });
}

function done() {
  const r = releaseSlot;
  releaseSlot = null;
  if (r) { try { r(null); } catch (e) {} }
  busy = false;
  if (queue.length) {
    const next = queue.shift();
    busy = true;
    setImmediate(() => startJob(next));
  }
}

// Runs makeThumb while holding a global ffmpeg-pool slot, so a background
// poster never adds an extra encoder on top of the request-path validator.
// If the pool is saturated the poster is skipped (cosmetic) and the queue keeps
// moving — the release is returned exactly once, by done().
function startJob(filePath) {
  releaseSlot = null;
  pool
    .run((release) => {
      releaseSlot = release;
      makeThumb(filePath);
    })
    .catch(() => {
      log("skipped (ffmpeg pool saturated)");
      done();
    });
}

function enqueueThumb(filePath) {
  if (!ENABLED || !filePath) return;
  if (busy) { queue.push(filePath); return; }
  busy = true;
  setImmediate(() => startJob(filePath));
}

module.exports = { enqueueThumb, FFMPEG, ENABLED };