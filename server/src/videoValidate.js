// Validates player highlight videos BEFORE they are accepted by the platform:
//   1) duration must be between 1 and 10 minutes
//   2) the video must look like a live, unedited recording — if FFmpeg detects
//      too many scene cuts per minute it is treated as an edited/doctored clip
//      and rejected immediately.
// Runs synchronously inside the upload route so the rejection reaches the
// player right away (the file is deleted and never stored).
const { spawn } = require("child_process");
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

function probeDuration(filePath, cb) {
  const args = [
    "-v", "error",
    "-show_entries", "format=duration",
    "-show_entries", "stream=width,height,codec_name",
    "-of", "json",
    filePath
  ];
  let out = "";
  const p = spawn(FFPROBE, args, { windowsHide: true });
  p.stdout.on("data", (d) => (out += d));
  p.on("error", () => cb(null));
  p.on("close", (code) => {
    if (code !== 0) return cb(null);
    try {
      const j = JSON.parse(out);
      const dur = +j.format.duration;
      const stream = (j.streams || [])[0] || {};
      cb({
        duration: isFinite(dur) ? dur : null,
        width: +stream.width || 0,
        height: +stream.height || 0,
        codec: stream.codec_name || ""
      });
    } catch (e) {
      cb(null);
    }
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
  const p = spawn(FFMPEG, args, { windowsHide: true });
  p.stderr.on("data", (d) => (err += d));
  p.on("error", () => cb(null));
  p.on("close", (code) => {
    if (code !== 0) return cb(null);
    const m = err.match(/lavfi\.scene_score=/g);
    cb(m ? m.length : 0);
  });
}

// cb({ ok: true }) or cb({ ok: false, code, message })
function validatePlayerVideo(filePath, cb) {
  probeDuration(filePath, (meta) => {
    if (!meta || !meta.duration) {
      return cb({ ok: false, code: "unreadable", message: "تعذر قراءة الفيديو — الملف غير صالح أو تالف" });
    }
    if (meta.duration < MIN_S) {
      return cb({ ok: false, code: "too_short", message: "❌ الفيديو أقل من دقيقة — يجب أن يكون من دقيقة إلى 10 دقائق" });
    }
    if (meta.duration > MAX_S) {
      return cb({ ok: false, code: "too_long", message: "❌ الفيديو أطول من 10 دقائق — يجب أن يكون من دقيقة إلى 10 دقائق" });
    }
    const short = Math.min(meta.width, meta.height);
    const long = Math.max(meta.width, meta.height);
    if (short < MIN_SHORT || long < MIN_LONG) {
      return cb({
        ok: false,
        code: "low_quality",
        message: "❌ جودة الفيديو منخفضة (" + meta.width + "x" + meta.height + ") — المطلوب 360p على الأقل (الطول أو العرض 640+) لضمان وضوح المعاينة"
      });
    }
    countSceneCuts(filePath, (cuts) => {
      if (cuts == null) return cb({ ok: true }); // could not analyse -> accept (fail-open)
      const windowMin = Math.min(meta.duration, WINDOW_S) / 60;
      const perMin = windowMin > 0 ? cuts / windowMin : 0;
      if (perMin > MAX_CUTS_PER_MIN) {
        return cb({
          ok: false,
          code: "edited",
          message: "❌ هذا الفيديو يبدو معدَّلاً (يحتوي قطعاً متكررة) — يجب رفع تسجيل حي كامل بدون أي تعديل"
        });
      }
      cb({ ok: true });
    });
  });
}

module.exports = { validatePlayerVideo, probeDuration };