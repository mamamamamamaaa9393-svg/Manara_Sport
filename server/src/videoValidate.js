// Validates player highlight videos BEFORE they are accepted by the platform:
//   1) duration must be between 1 and 10 minutes
//   2) the video must look like a live, unedited recording — if FFmpeg detects
//      too many scene cuts per minute it is treated as an edited/doctored clip
//      and rejected immediately.
// Runs synchronously inside the upload route so the rejection reaches the
// player right away (the file is deleted and never stored).
const { spawn } = require("child_process");
const pool = require("./ffmpegPool");
const { FFMPEG, FFPROBE } = require("./videoCompress");

const MIN_S = 60; // 1 minute — easy even for short phone recordings
const MAX_S = 10 * 60; // 10 minutes — keeps uploads light on slow devices/networks
// Resolution is orientation-aware: the SHORT side needs >=360px and the LONG
// side >=640px, so portrait phone videos are no longer rejected.
const MIN_SHORT = 360; // e.g. 640x360 landscape or 360x640 portrait
const MIN_LONG = 640;  // long edge for preview clarity
const MAX_CUTS_PER_MIN = 8; // tolerant of autofocus/stabilisation jumps; real montages cut far more often
const SCENE_THRESHOLD = "0.4";
const WINDOW_S = 120; // analyse the first 2 minutes (enough to detect editing)
const PROBE_TIMEOUT_MS = 30000;
const CUTS_TIMEOUT_MS = 180000; // scene-cut analysis over up to 2 minutes of video

// Hard timeout guard: kill a stuck child so a hung ffmpeg/ffprobe can never
// hold an upload request open forever (this runs inside the HTTP handler).
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
  const args = [
    "-v", "error",
    "-show_entries", "format=duration",
    "-show_entries", "stream=width,height,codec_name",
    "-of", "json",
    filePath
  ];
  let out = "";
  let done = false;
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); cb(r); };
  const p = spawn(FFPROBE, args, { windowsHide: true });
  p.stdout.on("data", (d) => { if (out.length < 8192) out += d; });
  p.on("error", () => finish(null));
  p.on("close", (code) => {
    if (code !== 0) return finish(null);
    try {
      const j = JSON.parse(out);
      const dur = +j.format.duration;
      const stream = (j.streams || [])[0] || {};
      finish({
        duration: isFinite(dur) ? dur : null,
        width: +stream.width || 0,
        height: +stream.height || 0,
        codec: stream.codec_name || ""
      });
    } catch (e) {
      finish(null);
    }
  });
  const timer = killAfter(p, PROBE_TIMEOUT_MS, () => {
    console.error("[video-validate] ffprobe timed out — killed: " + filePath);
    finish(null);
  });
}

function countSceneCuts(filePath, cb) {
  const args = [
    "-i", filePath,
    "-t", String(WINDOW_S),
    "-vf", "select='gt(scene," + SCENE_THRESHOLD + ")',metadata=mode=print",
    "-an", "-sn",
    "-f", "null", "-"
  ];
  let err = "";
  let done = false;
  const finish = (c) => { if (done) return; done = true; clearTimeout(timer); cb(c); };
  const p = spawn(FFMPEG, args, { windowsHide: true });
  p.stderr.on("data", (d) => { if (err.length < 65536) err += d; });
  p.on("error", () => finish(null));
  p.on("close", (code) => {
    if (code !== 0) return finish(null);
    const m = err.match(/lavfi\.scene_score=/g);
    finish(m ? m.length : 0);
  });
  const timer = killAfter(p, CUTS_TIMEOUT_MS, () => {
    console.error("[video-validate] scene-cut analysis timed out — killed: " + filePath);
    finish(null);
  });
}

// done({ ok: true }) or done({ ok: false, code, message })
function _validate(filePath, done) {
  probeDuration(filePath, (meta) => {
    if (!meta || !meta.duration) {
      return done({ ok: false, code: "unreadable", message: "تعذر قراءة الفيديو — الملف غير صالح أو تالف" });
    }
    if (meta.duration < MIN_S) {
      return done({ ok: false, code: "too_short", message: "❌ الفيديو أقل من دقيقة — يجب أن يكون من دقيقة إلى 10 دقائق" });
    }
    if (meta.duration > MAX_S) {
      return done({ ok: false, code: "too_long", message: "❌ الفيديو أطول من 10 دقائق — يجب أن يكون من دقيقة إلى 10 دقائق" });
    }
    const short = Math.min(meta.width, meta.height);
    const long = Math.max(meta.width, meta.height);
    if (short < MIN_SHORT || long < MIN_LONG) {
      return done({
        ok: false,
        code: "low_quality",
        message: "❌ جودة الفيديو منخفضة (" + meta.width + "x" + meta.height + ") — المطلوب 360p على الأقل (الطول أو العرض 640+) لضمان وضوح المعاينة"
      });
    }
    countSceneCuts(filePath, (cuts) => {
      if (cuts == null) return done({ ok: true }); // could not analyse -> accept (fail-open)
      const windowMin = Math.min(meta.duration, WINDOW_S) / 60;
      const perMin = windowMin > 0 ? cuts / windowMin : 0;
      if (perMin > MAX_CUTS_PER_MIN) {
        return done({
          ok: false,
          code: "edited",
          message: "❌ هذا الفيديو يبدو معدَّلاً (يحتوي قطعاً متكررة) — يجب رفع تسجيل حي كامل بدون أي تعديل"
        });
      }
      done({ ok: true });
    });
  });
}

// Every job runs inside the global ffmpeg pool (see ffmpegPool.js) so an
// unauthenticated burst of uploads cannot spawn an unbounded number of
// encoders. When the pool is saturated the caller gets { ok:false, code:"busy" }
// and the route answers 503 instead of piling up.
function validatePlayerVideo(filePath, cb) {
  pool.runCb((done) => _validate(filePath, (r) => done(null, r)), cb);
}

// Promise form, for callers that would otherwise wrap the callback in a
// Promise by hand (the pool rejects with FFMPEG_BUSY when it is saturated).
function validatePlayerVideoAsync(filePath) {
  return pool.run((done) => _validate(filePath, (r) => done(null, r)));
}

module.exports = { validatePlayerVideo, validatePlayerVideoAsync, probeDuration, pool };
