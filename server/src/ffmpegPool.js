// ---------------------------------------------------------------------------
// Global concurrency gate for FFmpeg/FFprobe jobs.
//
// WHY
// validatePlayerVideo() runs INSIDE the HTTP handler of an UNAUTHENTICATED
// endpoint (/api/upload/register-upload, 60 req/hour/IP). Every call spawns a
// full ffprobe + a 2-minute scene analysis — a 10-minute 4K clip is minutes of
// CPU. videoThumb/videoCompress are single-flight queues, so between them and
// the validator a burst could otherwise put dozens of encoders on one core.
// This gate caps the total at MAX_RUNNING and applies back-pressure (reject
// with 503) once MAX_QUEUED are waiting, so an overload fails fast instead of
// queueing until the box melts down.
// ---------------------------------------------------------------------------
const os = require("os");

const CPU = (os.cpus() || []).length || 2;
// Leave one core for node + nginx; never go below 2, never above 4.
const MAX_RUNNING = Math.max(2, Math.min(4, CPU - 1));
const MAX_QUEUED = 24;

let running = 0;
let queued = 0;
const waiting = [];

function stats() {
  return { running, queued: queued, waiting: waiting.length, maxRunning: MAX_RUNNING, maxQueued: MAX_QUEUED };
}

// Runs `fn(done)` while holding a slot. `done(err, value)` releases it.
// Rejects with a "busy" Error when the queue is full.
function run(fn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = (err, value) => {
      if (settled) return;
      settled = true;
      running = Math.max(0, running - 1);
      const next = waiting.shift();
      if (next) queued = Math.max(0, queued - 1);
      if (next) next();
      if (err) reject(err);
      else resolve(value);
    };

    const start = () => {
      running++;
      try {
        fn(release);
      } catch (e) {
        release(e);
      }
    };

    if (running < MAX_RUNNING) {
      start();
    } else if (waiting.length >= MAX_QUEUED) {
      const err = new Error("ffmpeg pool saturated");
      err.code = "FFMPEG_BUSY";
      reject(err);
    } else {
      queued++;
      waiting.push(start);
    }
  });
}

// Callback flavour for the existing validatePlayerVideo(cb) call sites.
function runCb(fn, cb) {
  run(fn).then(
    (v) => cb(v),
    () => cb({ ok: false, code: "busy", message: "الخدمة مشغولة حالياً — أعد المحاولة بعد قليل" })
  );
}

module.exports = { run, runCb, stats, MAX_RUNNING, MAX_QUEUED };
