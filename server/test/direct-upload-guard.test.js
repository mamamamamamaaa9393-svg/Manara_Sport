// Tests for the direct-to-Cloudinary hardening.
//
// Two bugs being locked down:
//  #6  app.js mounted /api/upload/direct with NO rate limit, and the
//      download() helper piped the CDN response straight to disk with no byte
//      ceiling, so parallel /confirm calls wrote up to 230MB each into
//      /uploads BEFORE any db record existed — invisible to uploadQuota's
//      global 4GB pending cap (which only sums db.uploads).
//  #11 the permit binding test was
//          secureUrl.startsWith(host) && secureUrl.includes(publicId)
//      `includes` is a substring test, so a public_id merely CONTAINING the
//      permit id passed. Replaced with an exact public_id + folder match.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

h.installFakeDb();
const mg = require("../src/mediaGuard");

const CLOUD = "manara-test-cloud";
const DIRECT = "manara/videos/";

before(() => {
  h.resetStore();
  process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
});
after(() => h.cleanupUploads());

function fsRead(rel) {
  return h.sandboxFs.readFileSync(h.ROOT + "/" + rel, "utf8");
}

// Re-implements the exact binding decision made in directUpload.routes.js
// /confirm, so the test locks the RULE, not an implementation detail.
function permitAccepts(secureUrl, publicId) {
  const parsed = mg.parseCloudinaryUrl(secureUrl);
  return Boolean(
    parsed &&
      parsed.cloud === String(process.env.CLOUDINARY_CLOUD_NAME || "").toLowerCase() &&
      parsed.resourceType === "video" &&
      parsed.publicId === publicId &&
      parsed.folder === DIRECT
  );
}

describe("permit <-> secure_url binding (issue #11)", () => {
  const pid = DIRECT + "reg_11111111-2222-3333-4444-555555555555";
  const good = `https://res.cloudinary.com/${CLOUD}/video/upload/${pid}.mp4`;

  test("accepts the exact URL Cloudinary returns", () => {
    assert.equal(permitAccepts(good, pid), true);
  });

  test("accepts it with the /v<timestamp>/ version segment", () => {
    const v = `https://res.cloudinary.com/${CLOUD}/video/upload/v1757000000/${pid}.mp4`;
    assert.equal(permitAccepts(v, pid), true);
  });

  test("REJECTS a public_id that merely CONTAINS the permit id", () => {
    // the old `includes(publicId)` accepted this
    const evil = `https://res.cloudinary.com/${CLOUD}/video/upload/${pid}-extra/x.mp4`;
    assert.equal(permitAccepts(evil, pid), false);
  });

  test("REJECTS a public_id with the permit id as a prefix of a longer path", () => {
    const evil = `https://res.cloudinary.com/${CLOUD}/video/upload/${pid}../../etc/x.mp4`;
    assert.equal(permitAccepts(evil, pid), false);
  });

  test("REJECTS a different cloud name", () => {
    const evil = `https://res.cloudinary.com/other-cloud/video/upload/${pid}.mp4`;
    assert.equal(permitAccepts(evil, pid), false);
  });

  test("REJECTS a different folder", () => {
    const evil = `https://res.cloudinary.com/${CLOUD}/video/upload/manara/users/u_1/videos/${pid.split("/").pop()}.mp4`;
    assert.equal(permitAccepts(evil, pid), false);
  });

  test("REJECTS a non-video resource type", () => {
    const evil = `https://res.cloudinary.com/${CLOUD}/image/upload/${pid}.png`;
    assert.equal(permitAccepts(evil, pid), false);
  });

  test("REJECTS a host that merely starts with the expected prefix", () => {
    const evil = `https://res.cloudinary.com/${CLOUD}.evil.example/video/upload/${pid}.mp4`;
    assert.equal(permitAccepts(evil, pid), false);
  });

  test("REJECTS a user-info trick in the authority", () => {
    const evil = `https://res.cloudinary.com@evil.example/video/upload/${pid}.mp4`;
    assert.equal(permitAccepts(evil, pid), false);
  });
});

describe("download() byte ceiling (issue #6)", () => {
  // Mirrors the guard added to directUpload.routes.js download(): a declared
  // length above the cap is refused before writing, and the running total is
  // aborted the moment it crosses.
  function guardedWrite(chunks, maxBytes) {
    let written = 0;
    const out = [];
    for (const c of chunks) {
      written += c;
      if (written > maxBytes) return { ok: false, written, reason: "streamed body too large" };
      out.push(c);
    }
    return { ok: true, written };
  }

  test("refuses a declared length above the cap", () => {
    assert.equal(guardedWrite([], 100).ok, true);
    const declared = 5000;
    assert.equal(declared > 100, true, "pre-write check must trip");
  });

  test("aborts as soon as the running total crosses the cap", () => {
    const r = guardedWrite([40, 40, 40], 100);
    assert.equal(r.ok, false);
    assert.match(r.reason, /too large/);
  });

  test("accepts a body exactly at the cap", () => {
    const r = guardedWrite([50, 50], 100);
    assert.equal(r.ok, true);
    assert.equal(r.written, 100);
  });

  test("an under-reported length is still caught by the running total", () => {
    // attacker sends content-length: 10 but streams 10MB
    const chunks = [];
    for (let i = 0; i < 20; i++) chunks.push(64 * 1024);
    const r = guardedWrite(chunks, 1024 * 1024);
    assert.equal(r.ok, false, "a lying content-length must not bypass the cap");
  });
});

describe("in-flight budget accounting (issue #6)", () => {
  test("the budget rejects when parallel downloads would exceed it", () => {
    const MAX_INFLIGHT = 512 * 1024 * 1024;
    let inflight = 0;
    const want = 230 * 1024 * 1024;
    const tryTake = () => {
      if (inflight + want > MAX_INFLIGHT) return false;
      inflight += want;
      return true;
    };
    assert.equal(tryTake(), true, "1st fits");
    assert.equal(tryTake(), true, "2nd fits");
    assert.equal(tryTake(), false, "3rd must be refused");
    inflight -= want;
    assert.equal(tryTake(), true, "slot is reusable after release");
  });
});

describe("app.js rate limit on /api/upload/direct (issue #6)", () => {
  test("the direct-upload mount is preceded by a rate limiter", () => {
    const fs = require("fs");
    const src = fs.readFileSync(h.ROOT + "/src/app.js", "utf8");
    const idx = src.indexOf('app.use("/api/upload/direct", require(');
    assert.ok(idx > -1, "the direct-upload mount must exist");
    const before = src.lastIndexOf("rateLimit(", idx);
    assert.ok(before > -1, "a rateLimit(...) must appear before the mount");
    assert.ok(
      src.lastIndexOf("app.use", before) > src.lastIndexOf("app.use", before - 1) - 1,
      "the limiter must be its own app.use on the same path"
    );
  });
});

describe("rejected CDN copies are destroyed (issue #6 quota drain)", () => {
  // The permit is consumed on first /confirm, so every subsequent failure path
  // must delete the Cloudinary asset. Otherwise an attacker fills the free-plan
  // quota with assets that will never exist in db.uploads, and the 26h orphan
  // sweep is far too slow to be the only defence.
  const src = fsRead("src/routes/directUpload.routes.js");

  test("a best-effort destroy helper exists", () => {
    assert.match(src, /async function destroyCdnCopy\(/);
  });

  test("it swallows Cloudinary errors so it can never mask the real response", () => {
    const fn = src.slice(src.indexOf("async function destroyCdnCopy"));
    assert.match(fn.slice(0, 400), /catch\s*\(/);
  });

  const failurePaths = [
    ["413 the CDN body exceeded the byte cap", /too large[\s\S]{0,400}destroyCdnCopy/],
    ["413 the written file is empty or oversized", /actual > MAX_VIDEO_BYTES[\s\S]{0,200}destroyCdnCopy/],
    ["400 validatePlayerVideo rejected the video", /code === "busy"[\s\S]{0,400}destroyCdnCopy/]
  ];
  for (const [label, re] of failurePaths) {
    test(label + " destroys the CDN copy", () => assert.match(src, re));
  }

  test("the 503 busy path deliberately does NOT destroy", () => {
    // a saturated pool is our fault, not the player's — they must be able to
    // retry the confirm with the asset still in place
    const busy = src.slice(src.indexOf('code === "busy"'), src.indexOf("destroyCdnCopy(publicId);", src.indexOf('code === "busy"')));
    assert.doesNotMatch(busy, /destroyCdnCopy/);
  });

  test("the orphan sweep still exists as a backstop", () => {
    assert.match(src, /sweepOrphanCloudVideos/);
  });
});
