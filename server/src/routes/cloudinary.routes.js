const router = require("express").Router();
const cloudinary = require("cloudinary").v2;
const { requireAuth } = require("../middleware/auth");
const requireActiveSub = require("../middleware/requireSub");
const db = require("../db");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validatePlayerVideo } = require("../videoValidate");

// FIX #3 (memory risk): disk storage instead of memoryStorage — large videos
// (up to 1GB) are buffered to a temp file OUTSIDE the web root (os.tmpdir),
// then streamed to Cloudinary, so RAM usage stays low. Temp files are always
// deleted afterwards (success or failure).
const TMP_DIR = path.join(os.tmpdir(), "manara-cloudinary-tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
}

// Same whitelist as the local upload system (uploads.routes.js)
const ACCEPTED_MIME_TYPES = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/3gpp": ".3gp",
  "video/3gpp2": ".3g2",
  "video/x-m4v": ".m4v",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf"
};

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + "_" + uuidv4())
});

const upload = multer({
  storage: diskStorage,
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB cap for highlight videos
});

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1GB
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10MB
const isVideo = (f) => f.mimetype && f.mimetype.startsWith("video/");

router.post(
  "/",
  requireAuth,
  requireActiveSub,
  upload.single("file"),
  async (req, res) => {
    const tmpPath = req.file ? req.file.path : null;
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided (use field name 'file')" });
      }
      // MIME whitelist check (same list as the local upload system)
      if (!ACCEPTED_MIME_TYPES[req.file.mimetype]) {
        safeUnlink(tmpPath);
        return res.status(400).json({ error: "File type not allowed: " + req.file.mimetype });
      }

      const userId = req.user.id; // owner comes ONLY from verified JWT (never from body)
      const purpose = String((req.body && req.body.purpose) || "");
      const mimeType = req.file.mimetype;
      const fileSize = req.file.size;

      // Size checks (mirrors the local upload system)
      if (isVideo(req.file)) {
        if (fileSize > MAX_VIDEO_BYTES) {
          safeUnlink(tmpPath);
          return res.status(400).json({ error: "الفيديو كبير جداً — الحد 1GB" });
        }
      } else if (fileSize > MAX_DOC_BYTES) {
        safeUnlink(tmpPath);
        return res.status(400).json({ error: "الملف أكبر من 10MB — غير مسموح" });
      }

      // Player highlight videos: 1-10 min, 360p minimum, no sign of editing —
      // validated locally BEFORE anything reaches Cloudinary.
      if (isVideo(req.file) && purpose === "player_video") {
        const vr = await new Promise((resolve) =>
          validatePlayerVideo(tmpPath, resolve)
        );
        if (!vr.ok) {
          safeUnlink(tmpPath);
          // A saturated ffmpeg pool is a server problem -> 503, not "bad video".
          if (vr.code === "busy") {
            return res.status(503).json({ error: vr.message, code: vr.code });
          }
          return res.status(400).json({ error: vr.message, code: vr.code });
        }
      }

      // Ownership-scoped, cryptographically unique public ID.
      // NEVER derived from the original filename.
      const publicId = `manara/users/${userId}/videos/${uuidv4()}`;
      const uploadParams = {
        resource_type: "video",
        public_id: publicId,
        overwrite: false,
        timeout: 300000
      };

      // Stream the temp file to Cloudinary (low memory footprint)
      let uploadResult;
      try {
        uploadResult = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(uploadParams, (error, result) => {
            if (error) reject(error);
            else resolve(result);
          });
          fs.createReadStream(tmpPath)
            .on("error", reject)
            .pipe(stream);
        });
      } catch (uploadError) {
        console.error("Cloudinary upload failed:", uploadError.message);
        safeUnlink(tmpPath);
        return res.status(502).json({ error: "Cloudinary upload failed" });
      }

      const store = db.get();
      let player = store.players.find((p) => p.userId === userId);
      if (!player) {
        player = {
          id: "p_" + db.nextId("player"),
          userId,
          videos: [],
          postedDays: 0,
          rating: 0,
          reviews: 0,
          createdAt: new Date().toISOString()
        };
        store.players.push(player);
      }
      player.videos = player.videos || [];

      const hasPrimary = player.videos.some((v) => v.isPrimary === true);

      // FIX #1 + #6 (primary logic): a plain upload only becomes primary when
      // NO primary exists yet — existing primaries are left untouched.
      // Explicit purpose="set-primary" promotes THIS new video and demotes
      // the user's other primaries (scoped to this user only).
      const shouldBePrimary =
        purpose === "set-primary" ? true : !hasPrimary;
      if (purpose === "set-primary") {
        player.videos.forEach((v) => { v.isPrimary = false; });
      }

      const videoRecord = {
        id: "v_" + db.nextId("video"),
        userId,
        publicId,
        secureUrl: uploadResult.secure_url,
        url: uploadResult.secure_url,
        resourceType: uploadResult.resource_type || "video",
        originalFilename: req.file.originalname,
        format: mimeType,
        bytes: fileSize,
        duration: uploadResult.duration || null,
        width: uploadResult.width || null,
        height: uploadResult.height || null,
        isPrimary: shouldBePrimary,
        createdAt: new Date().toISOString()
      };
      player.videos.push(videoRecord);

      // Rollback: if persistence fails, remove the orphaned Cloudinary asset
      // so storage isn't leaked. Failures are logged without credentials.
      try {
        db.save();
      } catch (saveErr) {
        console.error("DB save failed after Cloudinary upload:", saveErr.message);
        try {
          await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
        } catch (delErr) {
          console.error("Failed to clean up Cloudinary asset after DB failure:", delErr.message);
        }
        safeUnlink(tmpPath);
        return res.status(500).json({ error: "Database save failed — upload rolled back" });
      }

      safeUnlink(tmpPath);
      return res.status(201).json({
        id: videoRecord.id,
        publicId: videoRecord.publicId,
        secureUrl: videoRecord.secureUrl,
        url: videoRecord.url,
        isPrimary: videoRecord.isPrimary,
        duration: videoRecord.duration,
        format: videoRecord.format,
        size: videoRecord.bytes,
        message: "Video uploaded successfully"
      });
    } catch (err) {
      safeUnlink(tmpPath);
      console.error("Cloudinary upload error:", err.message);
      return res.status(500).json({ error: "Internal server error during video upload" });
    }
  }
);

// GET /api/cloudinary/:userId — list videos; users see ONLY their own list
router.get(
  "/:userId",
  requireAuth,
  async (req, res) => {
    try {
      const targetUserId = req.params.userId;
      if (req.user.id !== targetUserId && req.user.role !== "admin") {
        return res.status(403).json({ error: "Access denied — you can only view your own videos" });
      }

      const store = db.get();
      const player = store.players.find((p) => p.userId === targetUserId);
      if (!player || !player.videos || player.videos.length === 0) {
        return res.json({ videos: [] });
      }

      const videos = player.videos.map((v) => ({
        id: v.id,
        publicId: v.publicId,
        secureUrl: v.secureUrl,
        url: v.url || v.secureUrl,
        isPrimary: v.isPrimary,
        duration: v.duration,
        format: v.format,
        size: v.bytes,
        createdAt: v.createdAt
      }));

      return res.json({ videos });
    } catch (err) {
      console.error("Error fetching videos:", err.message);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// DELETE /api/cloudinary/:videoId — delete own video (ownership verified)
router.delete(
  "/:videoId",
  requireAuth,
  async (req, res) => {
    try {
      const videoId = req.params.videoId;
      const userId = req.user.id;

      const store = db.get();
      const player = store.players.find((p) => p.userId === userId);
      if (!player || !player.videos) {
        return res.status(404).json({ error: "No videos found for your account" });
      }

      // Lookup scoped to the caller's own profile: another user's video id
      // simply cannot be found here, so cross-user deletion is impossible.
      const idx = player.videos.findIndex((v) => v.id === videoId);
      if (idx === -1) {
        return res.status(404).json({ error: "Video not found" });
      }

      const wasPrimary = player.videos[idx].isPrimary === true;
      const deletedPublicId = player.videos[idx].publicId;

      try {
        await cloudinary.uploader.destroy(deletedPublicId, { resource_type: "video" });
      } catch (cloudError) {
        console.error("Cloudinary deletion error:", cloudError.message);
        // Asset may remain in Cloudinary, but ownership record is removed.
      }

      player.videos.splice(idx, 1);

      // Promote nothing silently: if the deleted video was primary, promote
      // the oldest remaining video so the profile keeps exactly one primary.
      if (wasPrimary && player.videos.length > 0 && !player.videos.some((v) => v.isPrimary)) {
        player.videos[0].isPrimary = true;
      }

      db.save();

      return res.json({ message: "Video deleted successfully", deletedId: videoId });
    } catch (err) {
      console.error("Error deleting video:", err.message);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PUT /api/cloudinary/:videoId/set-primary — promote one of OWN videos
router.put(
  "/:videoId/set-primary",
  requireAuth,
  async (req, res) => {
    try {
      const videoId = req.params.videoId;
      const userId = req.user.id;

      const store = db.get();
      const player = store.players.find((p) => p.userId === userId);
      if (!player || !player.videos) {
        return res.status(404).json({ error: "No videos found for your account" });
      }

      const target = player.videos.find((v) => v.id === videoId);
      if (!target) {
        return res.status(404).json({ error: "Video not found" });
      }

      // Scoped lookup guarantees ownership; admin bypass unnecessary here.
      player.videos.forEach((v) => { v.isPrimary = v.id === videoId; });
      db.save();

      // FIX #2 (stale response): report the freshly-computed value instead of
      // reading a captured object reference that map/spread did not mutate.
      return res.json({
        message: "Primary video updated successfully",
        isPrimary: true,
        videoId
      });
    } catch (err) {
      console.error("Error setting primary video:", err.message);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;