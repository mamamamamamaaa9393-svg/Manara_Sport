// Issue #10: roster/libs/ffmpeg was MISSING locally, so Sign_Up.html's
// compressVideoFile() 404'd on /libs/ffmpeg/ffmpeg.min.js, loadFfmpeg()
// rejected, and every video >15MB was uploaded uncompressed while a 900-line
// comment above it described behaviour that could never run.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const LIBS = path.join(__dirname, "..", "..", "roster", "libs", "ffmpeg");
const REQUIRED = ["ffmpeg.min.js", "ffmpeg-core.js", "ffmpeg-core.wasm", "ffmpeg-core.worker.js"];

describe("client-side ffmpeg (issue #10)", () => {
  test("roster/libs/ffmpeg exists", () => {
    assert.ok(fs.existsSync(LIBS), LIBS + " must exist — the sign-up page loads /libs/ffmpeg/");
  });

  for (const f of REQUIRED) {
    test(f + " is present and non-empty", () => {
      const p = path.join(LIBS, f);
      assert.ok(fs.existsSync(p), p + " is missing");
      assert.ok(fs.statSync(p).size > 0, p + " is empty");
    });
  }

  test("the wasm core is a real wasm module", () => {
    const buf = fs.readFileSync(path.join(LIBS, "ffmpeg-core.wasm"));
    assert.equal(buf.slice(0, 4).toString("binary"), "\0asm", "missing \\0asm magic header");
  });

  test("the loader script exposes the createFFmpeg global the page calls", () => {
    const src = fs.readFileSync(path.join(LIBS, "ffmpeg.min.js"), "utf8");
    assert.match(src, /createFFmpeg/);
  });

  test("the sign-up page references the same base path", () => {
    const html = fs.readFileSync(
      path.join(__dirname, "..", "..", "roster", "Sign", "Sign_Up.html"),
      "utf8"
    );
    assert.match(html, /FFMPEG_BASE\s*=\s*'\/libs\/ffmpeg\/'/);
    for (const f of REQUIRED) {
      assert.ok(html.includes(f), "Sign_Up.html must reference " + f);
    }
  });

  test("the page still degrades gracefully when the libs are absent", () => {
    // every failure path must resolve null (upload the original) rather than
    // leaving the submit button spinning forever
    const html = fs.readFileSync(
      path.join(__dirname, "..", "..", "roster", "Sign", "Sign_Up.html"),
      "utf8"
    );
    const fn = html.slice(html.indexOf("function compressVideoFile"));
    assert.ok(fn.length > 0, "compressVideoFile must exist");
    // fail-open paths: direct resolve(null) plus finish(null), which resolves null
    const nullPaths =
      (fn.match(/resolve\(null\)/g) || []).length + (fn.match(/finish\(null\)/g) || []).length;
    assert.ok(nullPaths >= 4, "expected >=4 fail-open paths, found " + nullPaths);
    // and no path may leave the promise unsettled on an unexpected throw
    assert.match(fn, /\.catch\(/, "loadFfmpeg must have a .catch fallback");
  });
});
