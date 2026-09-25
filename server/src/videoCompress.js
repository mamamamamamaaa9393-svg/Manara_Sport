// Automatic background compression of uploaded MP4 videos using FFmpeg.
// Runs AFTER the HTTP response is sent: the original file is kept until the
// compressed copy is ready, then swapped in-place under the same filename, so
// existing URLs keep working (clubs, admins and the public all see the same
// link). If compression fails for any reason the original file stays intact.
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
  return "ffmpeg"; // fall back to PATH
}

const FFMPEG = process.env.FFMPEG_PATH || findFfmpeg();
// Derive ffprobe from the ffmpeg path robustly: handles a bare "ffmpeg" on PATH,
// a Windows "ffmpeg.exe", and a full directory path on either OS.
const FFPROBE = FFMPEG ? FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1") : null;
const ENABLED = !!FFMPEG;
const MIN_COMPRESS_BYTES = 2 * 1024 * 1024; // skip tiny files
const MAX_H = 720; // cap height (e.g. 1080x1920 portrait -> 405x720)
const MAX_W = 1280; // cap width  (e.g. 1920x1080 landscape -> 1280x720)
const CRF = "26";
const PRESET = "faster";
const AUDIO_BITRATE = "96k";
const MAX_DURATION_S = 3600;

let queue = [];
let busy = false;

const PROBE_TIMEOUT_MS = 30000; // a healthy ffprobe on a 230MB clip finishes in seconds
const FFMPEG_TIMEOUT_MS = 1200000; // 20 min for a large compress job; prevents a hung process

function log(msg) {
  try {
    console.log("[video-compress] " + msg);
  } catch (e) {}
}

// Hard timeout guard: if the child hasn't exited within ms, kill it and report
// failure. Without this a stuck ffmpeg/ffprobe would hold the busy flag forever
// and starve the whole background queue.
function killAfter(p, ms, onTimeout) {
  const t = setTimeout(() => {
    try { p.kill("SIGKILL"); } catch (e) {}
    onTimeout();
  }, ms);
  p.on("close", () => clearTimeout(t));
  p.on("error", () => clearTimeout(t));
  return t;
}

function probeVideo(filePath, cb) {
  const ffprobe = FFMPEG ? FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1") : null;
  if (!ffprobe) return cb(null);
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-show_entries", "format=duration,size",
    "-of", "json",
    filePath
  ];
  let out = "";
  let done = false;
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); cb(r); };
  const p = spawn(ffprobe, args, { windowsHide: true });
  p.stdout.on("data", (d) => { if (out.length < 8192) out += d; });
  p.on("error", () => finish(null));
  p.on("close", (code) => {
    if (code !== 0) return finish(null);
    try {
      const j = JSON.parse(out);
      const s = j.streams && j.streams[0];
      finish({
        width: +(s && s.width) || 0,
        height: +(s && s.height) || 0,
        duration: +(j.format && j.format.duration) || 0
      });
    } catch (e) {
      finish(null);
    }
  });
  const timer = killAfter(p, PROBE_TIMEOUT_MS, () => {
    log("ffprobe timed out — killed: " + filePath);
    finish(null);
  });
}

function runFfmpeg(filePath, tmpOut, cb) {
  const vf =
    "scale='min(" + MAX_W + ",iw)':'min(" + MAX_H + ",ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  const args = [
    "-y", "-i", filePath,
    "-map", "0:v:0", "-map", "0:a?",
    "-vf", vf,
    "-c:v", "libx264", "-preset", PRESET, "-crf", CRF,
    "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", AUDIO_BITRATE,
    "-movflags", "+faststart",
    "-threads", "2",
    tmpOut
  ];
  let done = false;
  const finish = (ok, note) => { if (done) return; done = true; clearTimeout(timer); cb(ok, note); };
  const p = spawn(FFMPEG, args, { windowsHide: true });
  let errLog = "";
  p.stderr.on("data", (d) => {
    if (errLog.length < 2000) errLog += d;
  });
  p.on("error", (e) => {
    log("ffmpeg spawn error: " + e.message);
    finish(false, null);
  });
  p.on("close", (code) => {
    if (code !== 0) {
      log("ffmpeg failed (" + code + "): " + errLog.slice(-400).replace(/\s+/g, " ").trim());
      finish(false, null);
    } else {
      finish(true, null);
    }
  });
  const timer = killAfter(p, FFMPEG_TIMEOUT_MS, () => {
    log("ffmpeg timed out — killed: " + filePath);
    finish(false, null);
  });
}

function swapInPlace(filePath, tmpOut, cb) {
  let attempts = 0;
  const trySwap = () => {
    try {
      fs.renameSync(tmpOut, filePath);
      cb(true);
    } catch (e) {
      if (attempts++ < 5) {
        setTimeout(trySwap, 400); // file may be briefly locked by an open stream
      } else {
        try {
          fs.unlinkSync(tmpOut);
        } catch (e2) {}
        cb(false);
      }
    }
  };
  trySwap();
}

function processFile(filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st || st.size < MIN_COMPRESS_BYTES) return done();
    probeVideo(filePath, (meta) => {
      if (!meta) return done();
      if (meta.height && meta.height <= 480 && meta.width && meta.width <= 854) return done();
      if (meta.duration && meta.duration > MAX_DURATION_S) return done();
      const tmpOut = filePath + ".tmp" + process.pid + ".mp4";
      runFfmpeg(filePath, tmpOut, (ok) => {
        if (!ok) {
          try {
            fs.unlinkSync(tmpOut);
          } catch (e) {}
          return done();
        }
        swapInPlace(filePath, tmpOut, done);
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

// Compression holds a global ffmpeg-pool slot for the whole re-encode (a 230MB
// clip can take minutes). A saturated pool skips the job — the original file
// simply stays as uploaded, which is exactly the documented fallback.
function startJob(filePath) {
  releaseSlot = null;
  pool
    .run((release) => {
      releaseSlot = release;
      processFile(filePath);
    })
    .catch(() => {
      log("skipped (ffmpeg pool saturated)");
      done();
    });
}

function enqueueCompress(filePath) {
  if (!ENABLED) return;
  if (busy) {
    queue.push(filePath);
    return;
  }
  busy = true;
  setImmediate(() => startJob(filePath));
}

module.exports = { enqueueCompress, FFMPEG, FFPROBE };