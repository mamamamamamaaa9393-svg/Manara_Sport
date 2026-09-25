// Regression tests for the media-reference guard (server/src/mediaGuard.js).
//
// Bug being locked down: before this module, isKnownVideoUrl() in
// auth.routes.js accepted ANY string that named an existing file in /uploads —
// so a PDF or a JPEG could be submitted as a "highlight video" — and
// players.routes.js pickPlayer() copied `videos` / `documents` / `photo`
// verbatim from the request body, letting any authenticated user store an
// arbitrary external URL in a public profile field.
const { test, before, after, beforeEach, afterEach, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const h = require("./harness");

h.installFakeDb();
const mg = require("../src/mediaGuard");

const CLOUD = "manara-test-cloud";

let realMp4;   // an existing .mp4 on disk
let realPdf;   // an existing .pdf on disk
let realJpg;   // an existing .jpg on disk

before(() => {
  h.resetStore();
  realMp4 = h.makeUploadFile("t_guard_video.mp4", 128);
  realPdf = h.makeUploadFile("t_guard_doc.pdf", 128);
  realJpg = h.makeUploadFile("t_guard_photo.jpg", 128);
  // Production ALWAYS creates an upload record before a URL is handed to a
  // client (uploads.routes makeRecord / finalizeFileRecord, directUpload
  // /confirm, cloudinary.routes), so the guard requires one. Seed the records
  // the real flow would already have written.
  h.store.uploads.push(
    { id: "up_mp4", url: realMp4, mimetype: "video/mp4", name: "v.mp4" },
    { id: "up_pdf", url: realPdf, mimetype: "application/pdf", name: "d.pdf" },
    { id: "up_jpg", url: realJpg, mimetype: "image/jpeg", name: "p.jpg" }
  );
});

after(() => {
  h.cleanupUploads();
});

describe("isKnownVideoUrl — must REJECT", () => {
  const bad = [
    ["arbitrary external https", "https://attacker.example/x.mp4"],
    ["external http (not TLS)", "http://attacker.example/x.mp4"],
    ["protocol-relative", "//attacker.example/x.mp4"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["data: uri", "data:video/mp4;base64,AAAA"],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["non-string", 12345],
    ["null", null],
    ["undefined", undefined],
    ["object", { url: realMp4 }],
    ["path traversal out of uploads", "/uploads/../data/db.json"],
    ["encoded traversal", "/uploads/..%2fdata%2fdb.json"],
    ["bare filesystem path", "C:/Windows/win.ini"],
    ["uploads dir itself", "/uploads/"],
    ["nonexistent local mp4", "/uploads/t_does_not_exist_12345.mp4"]
  ];
  for (const [label, url] of bad) {
    test(label, () => assert.equal(mg.isKnownVideoUrl(url), false, label + " must be rejected"));
  }

  test("a PDF is never a video", () =>
    assert.equal(mg.isKnownVideoUrl(realPdf), false));

  test("a JPEG is never a video", () =>
    assert.equal(mg.isKnownVideoUrl(realJpg), false));

  test("our CDN but a different cloud name", () =>
    assert.equal(
      mg.isKnownVideoUrl("https://res.cloudinary.com/someone-else/video/upload/manara/videos/reg_x.mp4"),
      false
    ));

  test("our CDN but image resource_type", () =>
    assert.equal(
      mg.isKnownVideoUrl(`https://res.cloudinary.com/${CLOUD}/image/upload/manara/videos/x.png`),
      false
    ));

  test("our CDN but a non-video extension", () =>
    assert.equal(
      mg.isKnownVideoUrl(`https://res.cloudinary.com/${CLOUD}/video/upload/manara/videos/x.pdf`),
      false
    ));

  test("our CDN with traversal in the path", () =>
    assert.equal(
      mg.isKnownVideoUrl(`https://res.cloudinary.com/${CLOUD}/video/upload/manara/videos/../../x.mp4`),
      false
    ));
});

describe("isKnownVideoUrl — must ACCEPT", () => {
  test("an existing local .mp4 with an upload record", () =>
    assert.equal(mg.isKnownVideoUrl(realMp4), true));

  test("surrounding whitespace is tolerated", () =>
    assert.equal(mg.isKnownVideoUrl("  " + realMp4 + "  "), true));

  test("our CDN video url with a manara/ public_id", () => {
    const url = `https://res.cloudinary.com/${CLOUD}/video/upload/manara/videos/reg_abc-123.mp4`;
    h.store.uploads.push({ id: "up_cdn1", url, mimetype: "video/mp4" });
    assert.equal(mg.isKnownVideoUrl(url), true);
  });

  test("our CDN video url with the /v<timestamp>/ version segment", () => {
    const url = `https://res.cloudinary.com/${CLOUD}/video/upload/v1757000000/manara/videos/reg_abc-123.mp4`;
    h.store.uploads.push({ id: "up_cdn2", url, mimetype: "video/mp4" });
    assert.equal(mg.isKnownVideoUrl(url), true);
  });

  test("a record whose url was promoted to the CDN is still matched by localUrl", () => {
    const local = "/uploads/t_promoted.mp4";
    h.store.uploads.push({
      id: "up_1",
      url: `https://res.cloudinary.com/${CLOUD}/video/upload/manara/videos/reg_z.mp4`,
      localUrl: local,
      mimetype: "video/mp4"
    });
    // The client still holds the pre-promotion local URL. The file may already
    // be gone, but the record remembers it -> must NOT be treated as a forgery.
    assert.equal(mg.isKnownVideoUrl(local), true);
  });
});

describe("parseCloudinaryUrl", () => {
  test("splits cloud / resource_type / public_id / ext", () => {
    const p = mg.parseCloudinaryUrl(
      `https://res.cloudinary.com/${CLOUD}/video/upload/manara/videos/reg_9f2.mp4`
    );
    assert.equal(p.cloud, CLOUD);
    assert.equal(p.resourceType, "video");
    assert.equal(p.publicId, "manara/videos/reg_9f2");
    assert.equal(p.ext, "mp4");
    assert.equal(p.folder, "manara/videos/");
  });

  test("strips the version segment", () => {
    const p = mg.parseCloudinaryUrl(
      `https://res.cloudinary.com/${CLOUD}/video/upload/v1234567890/manara/videos/reg_9f2.mov`
    );
    assert.equal(p.publicId, "manara/videos/reg_9f2");
    assert.equal(p.ext, "mov");
  });

  test("rejects a non-cloudinary host", () =>
    assert.equal(mg.parseCloudinaryUrl("https://evil.example/video/upload/a/b.mp4"), null));

  test("rejects double slashes", () =>
    assert.equal(
      mg.parseCloudinaryUrl(`https://res.cloudinary.com/${CLOUD}/video/upload//a/b.mp4`),
      null
    ));

  test("rejects a query string", () =>
    assert.equal(
      mg.parseCloudinaryUrl(`https://res.cloudinary.com/${CLOUD}/video/upload/a/b.mp4?x=1`),
      null
    ));

  test("rejects a missing extension", () =>
    assert.equal(mg.parseCloudinaryUrl(`https://res.cloudinary.com/${CLOUD}/video/upload/a/b`), null));
});

describe("checkVideos", () => {
  test("passes a valid list through", () => {
    const r = mg.checkVideos([{ url: realMp4, name: "a.mp4", size: 128, duration: 90 }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.length, 1);
    assert.equal(r.value[0].url, realMp4);
  });

  test("rejects a non-array", () => {
    assert.equal(mg.checkVideos("nope").ok, false);
    assert.equal(mg.checkVideos({ 0: { url: realMp4 } }).ok, false);
  });

  test("rejects an entry that is not an object", () => {
    assert.equal(mg.checkVideos([realMp4]).ok, false);
    assert.equal(mg.checkVideos([null]).ok, false);
  });

  test("strips smuggled extra fields (publicId / provider / uploadedBy)", () => {
    const r = mg.checkVideos([
      {
        url: realMp4,
        publicId: "manara/users/u_x/videos/steal",
        provider: "cloudinary",
        uploadedBy: "pending",
        isPrimary: true
      }
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.value[0]).sort(), ["url"]);
  });

  test("enforces MAX_VIDEOS", () => {
    const many = [];
    for (let i = 0; i < mg.MAX_VIDEOS + 1; i++) many.push({ url: realMp4 });
    assert.equal(mg.checkVideos(many).ok, false);
  });

  test("undefined means 'field not supplied' and is not an error", () => {
    const r = mg.checkVideos(undefined);
    assert.equal(r.ok, true);
    assert.equal(r.value, undefined);
  });

  test("rejects a document smuggled in as a video", () =>
    assert.equal(mg.checkVideos([{ url: realPdf }]).ok, false));
});

describe("checkDocuments", () => {
  test("accepts a map of real local files", () => {
    const r = mg.checkDocuments({ birth_cert: realPdf, medical: realJpg });
    assert.equal(r.ok, true);
    assert.equal(r.value.birth_cert, realPdf);
  });

  test("rejects an external url smuggled into a proof document", () => {
    const r = mg.checkDocuments({ birth_cert: "https://attacker.example/id.pdf" });
    assert.equal(r.ok, false);
  });

  test("rejects a bad key", () => {
    assert.equal(mg.checkDocuments({ "a b": realPdf }).ok, false);
    assert.equal(mg.checkDocuments({ "birth-cert!": realPdf }).ok, false);
  });

  test("rejects a prototype-polluting key", () => {
    // JSON.parse (what express uses) DOES create __proto__ as an own key
    const evil = JSON.parse('{"__proto__":"https://attacker.example/x.pdf"}');
    assert.equal(Object.prototype.hasOwnProperty.call(evil, "__proto__"), true);
    assert.equal(mg.checkDocuments(evil).ok, false);
    assert.equal({}.polluted, undefined);
  });

  test("rejects an array", () => assert.equal(mg.checkDocuments([realPdf]).ok, false));

  test("drops empty values instead of failing", () => {
    const r = mg.checkDocuments({ birth_cert: "", medical: null });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, {});
  });

  test("accepts a bare string form", () => {
    const r = mg.checkDocuments(realPdf);
    assert.equal(r.ok, true);
    assert.equal(r.value, realPdf);
  });
});

describe("checkProfileMedia", () => {
  test("removes the unsanitised copies so Object.assign cannot re-add them", () => {
    const picked = { name: "x", videos: [{ url: "https://evil.example/a.mp4" }], photo: realJpg };
    const r = mg.checkProfileMedia(picked);
    assert.equal(r.ok, false, "external video must be refused");
  });

  test("returns ONLY the sanitised media keys for a legitimate payload", () => {
    const r = mg.checkProfileMedia({ name: "x", videos: [{ url: realMp4 }], photo: realJpg });
    assert.equal(r.ok, true);
    // non-media fields are NOT copied — the caller merges over its own object
    assert.deepEqual(Object.keys(r.value).sort(), ["photo", "videos"]);
    assert.equal(r.value.videos[0].url, realMp4);
    assert.equal(r.value.photo, realJpg);
  });

  test("omits untouched fields entirely", () => {
    const r = mg.checkProfileMedia({ name: "x" });
    assert.equal(r.ok, true);
    assert.equal("videos" in r.value, false);
    assert.equal("photo" in r.value, false);
  });
});

describe("db.get() unavailable -> fail closed, never throw", () => {
  // Found by the PRODUCTION smoke test: db.get() returns null until db.init()
  // resolves, and stays null if the db file is unreadable. owningRecord() used
  // to dereference it directly, so the guard threw a TypeError and turned a
  // clean 400 into a 500.
  let realGet;
  beforeEach(() => { realGet = h.fakeDb.get; });
  afterEach(() => { h.fakeDb.get = realGet; h.resetStore(); });

  test("isKnownVideoUrl returns false instead of throwing when db.get() is null", () => {
    h.fakeDb.get = () => null;
    assert.equal(mg.isKnownVideoUrl("/uploads/t_guard_video.mp4"), false);
  });

  test("isKnownMediaUrl returns false instead of throwing when db.get() is null", () => {
    h.fakeDb.get = () => null;
    assert.equal(mg.isKnownMediaUrl("/uploads/t_guard_photo.jpg"), false);
  });

  test("isKnownVideoUrl returns false when db.get() throws", () => {
    h.fakeDb.get = () => { throw new Error("db exploded"); };
    assert.equal(mg.isKnownVideoUrl("/uploads/t_guard_video.mp4"), false);
  });

  test("checkVideos returns ok:false, not an exception", () => {
    h.fakeDb.get = () => null;
    const r = mg.checkVideos([{ url: "/uploads/t_guard_video.mp4" }]);
    assert.equal(r.ok, false);
  });

  test("checkProfileMedia returns ok:false, not an exception", () => {
    h.fakeDb.get = () => null;
    const r = mg.checkProfileMedia({ videos: [{ url: realMp4 }], photo: realJpg });
    assert.equal(r.ok, false);
  });

  test("a null store also blocks Cloudinary urls", () => {
    h.fakeDb.get = () => null;
    const url = "https://res.cloudinary.com/" + CLOUD + "/video/upload/manara/videos/x.mp4";
    assert.equal(mg.isKnownVideoUrl(url), false);
  });
});

describe("promotion race: local file deleted, record keeps localUrl", () => {
  // uploads.routes promoteToCloudLater() rewrites rec.url to the CDN URL, keeps
  // rec.localUrl, then DELETES the local file. A sign-up client still holding
  // the pre-promotion /uploads/... value must validate, otherwise the fix would
  // break a legitimate sign-up (checking the disk first would reject it).
  const LOCAL = "/uploads/t_promoted_video.mp4";
  const CDN = "https://res.cloudinary.com/manara-test-cloud/video/upload/manara/videos/promoted_1.mp4";

  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = "manara-test-cloud";
    h.resetStore();
    h.store.uploads.push({
      id: "up_promoted",
      url: CDN,
      localUrl: LOCAL,
      mimetype: "video/mp4",
      name: "p.mp4"
    });
  });

  afterEach(() => h.cleanupUploads());

  test("the local file really is gone (so the test is meaningful)", () => {
    assert.equal(fs.existsSync(path.join(h.SANDBOX_UPLOADS, "t_promoted_video.mp4")), false);
  });

  test("the pre-promotion local URL is still accepted as a video", () => {
    assert.equal(mg.isKnownVideoUrl(LOCAL), true);
  });

  test("the new CDN URL is accepted as a video", () => {
    assert.equal(mg.isKnownVideoUrl(CDN), true);
  });

  test("checkVideos accepts a pre-promotion local URL", () => {
    const r = mg.checkVideos([{ url: LOCAL, name: "p.mp4", size: 10, duration: 12 }]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value[0].url, LOCAL);
  });

  test("a promoted record whose mimetype is NOT a video is refused", () => {
    h.store.uploads[0].mimetype = "application/pdf";
    assert.equal(mg.isKnownVideoUrl(LOCAL), false);
  });

  test("a same-cloud, same-folder CDN video with NO record is refused", () => {
    const foreign = "https://res.cloudinary.com/manara-test-cloud/video/upload/manara/videos/someone_elses.mp4";
    assert.equal(mg.isKnownVideoUrl(foreign), false);
  });

  test("documents/photos require a record for a CDN url", () => {
    const orphan = "https://res.cloudinary.com/manara-test-cloud/raw/upload/manara/docs/other_persons_id.pdf";
    assert.equal(mg.isKnownMediaUrl(orphan), false);
  });

  test("a document with a real record is accepted", () => {
    const doc = "/uploads/t_doc_ok.pdf";
    h.makeUploadFile("t_doc_ok.pdf", 64);
    h.store.uploads.push({ id: "up_doc", url: doc, mimetype: "application/pdf" });
    assert.equal(mg.isKnownMediaUrl(doc), true);
    const r = mg.checkDocuments({ license: doc });
    assert.equal(r.ok, true, r.error);
  });
});
