// Minimal in-memory fixed-window rate limiter (per IP by default, or a
// custom key — e.g. an authenticated user id — via the `key` option).
// Good enough for a single-process dev/local deployment; swap for
// express-rate-limit + Redis when scaling horizontally.
function rateLimit({
  windowMs = 15 * 60 * 1000,
  max = 100,
  message = "Too many requests — try again later",
  key = null
} = {}) {
  const hits = new Map();
  const keyOf = key || ((req) => req.ip || req.socket.remoteAddress || "unknown");
  return function (req, res, next) {
    const k = keyOf(req);
    const now = Date.now();
    // Prune stale keys when the map grows (memory bound for long uptime).
    if (hits.size > 10000) {
      hits.forEach((rec, key) => { if (now - rec.start >= windowMs) hits.delete(key); });
    }
    const rec = hits.get(k);
    if (!rec || now - rec.start >= windowMs) {
      hits.set(k, { start: now, count: 1 });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      return res.status(429).json({ error: message });
    }
    next();
  };
}

module.exports = rateLimit;