// Automatic poster/thumbnail generation for uploaded videos using FFmpeg.
// Extracts a single JPEG frame (~2s in, or ~10% for very long clips) as
// <video-basename>.jpg right next to the video. The URL is deterministic
// (video /uploads/x.mp4  ->  thumbnail /uploads/x.jpg), so the frontend just
// appends the poster. If anything fails the video is left untouched.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

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

function log(msg) {
  try { console.log("[video-thumb] " + msg); } catch (e) {}
}

function probeDuration(filePath, cb) {
  const ffprobe = FFMPEG ? FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1") : null;
  if (!ffprobe) return cb(2);
  let out = "";
  const p = spawn(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath
  ], { windowsHide: true });
  p.stdout.on("data", (d) => (out += d));
  p.on("error", () => cb(2));
  p.on("close", (code) => {
    if (code !== 0) return cb(2);
    try {
      const j = JSON.parse(out);
      const d = +(j.format && j.format.duration) || 0;
      cb(d > 0 ? d : 2);
    } catch (e) { cb(2); }
  });
}

function makeThumb(filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st || st.size < MIN_VIDEO_BYTES) return done();
    const thumbPath = filePath.replace(/\.[^/.]+$/, "") + ".jpg";
    probeDuration(filePath, (duration) => {
      const seek = Math.min(duration, Math.max(1.5, duration * 0.1));
      const tmpOut = thumbPath + ".tmp" + process.pid + ".jpg";
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
      p.on("error", () => done());
      p.on("close", (code) => {
        if (code !== 0) {
          try { fs.unlinkSync(tmpOut); } catch (e) {}
          log("extract failed (" + code + "): " + errLog.slice(-200).replace(/\s+/g, " ").trim());
          return done();
        }
        // Replace any existing thumbnail in place.
        try { fs.renameSync(tmpOut, thumbPath); } catch (e) {
          try { fs.copyFileSync(tmpOut, thumbPath); } catch (e2) {}
          try { fs.unlinkSync(tmpOut); } catch (e3) {}
        }
        done();
      });
    });
  });
}

function done() {
  busy = false;
  if (queue.length) {
    const next = queue.shift();
    busy = true;
    setImmediate(() => makeThumb(next));
  }
}

function enqueueThumb(filePath) {
  if (!ENABLED || !filePath) return;
  if (busy) { queue.push(filePath); return; }
  busy = true;
  setImmediate(() => makeThumb(filePath));
}

module.exports = { enqueueThumb, FFMPEG, ENABLED };