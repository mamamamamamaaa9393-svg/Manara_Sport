// Tests for the global ffmpeg concurrency gate (server/src/ffmpegPool.js).
//
// Bug being locked down: validatePlayerVideo() runs inside an UNAUTHENTICATED
// request handler (/api/upload/register-upload, 60 req/hour/IP) and each call
// spawns a full ffprobe + scene analysis. With no cap, a burst put an unbounded
// number of encoders on one core and queued until the box became unresponsive.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../src/ffmpegPool");

const MAX = pool.MAX_RUNNING;

describe("ffmpegPool", () => {
  test("MAX_RUNNING is a sane, bounded number", () => {
    assert.ok(MAX >= 2, "must allow at least 2 concurrent jobs");
    assert.ok(MAX <= 4, "must never exceed 4 concurrent jobs");
  });

  test("never runs more than MAX_RUNNING jobs at once", async () => {
    let active = 0;
    let peak = 0;
    const jobs = [];
    for (let i = 0; i < MAX * 5; i++) {
      jobs.push(
        pool.run(
          (done) =>
            setTimeout(() => {
              active++;
              if (active > peak) peak = active;
              active--;
              done(null, i);
            }, 12)
        )
      );
    }
    const results = await Promise.all(jobs);
    assert.equal(peak <= MAX, true, "peak concurrency was " + peak + ", limit is " + MAX);
    assert.equal(results.length, MAX * 5);
  });

  test("every queued job still runs and resolves", async () => {
    const seen = [];
    const jobs = [];
    for (let i = 0; i < MAX * 4; i++) {
      jobs.push(
        pool.run((done) => setTimeout(() => { seen.push(i); done(null, i); }, 5))
      );
    }
    const out = await Promise.all(jobs);
    assert.equal(out.length, MAX * 4);
    assert.deepEqual(seen.slice().sort((a, b) => a - b), out.slice().sort((a, b) => a - b));
  });

  test("the slot is released when the job reports an error", async () => {
    const before = pool.stats().running;
    await assert.rejects(
      pool.run((done) => done(new Error("boom"))),
      /boom/
    );
    assert.equal(pool.stats().running, before, "a failed job must not leak its slot");
  });

  test("the slot is released when the job throws synchronously", async () => {
    const before = pool.stats().running;
    await assert.rejects(
      pool.run(() => { throw new Error("sync-boom"); }),
      /sync-boom/
    );
    assert.equal(pool.stats().running, before, "a throwing job must not leak its slot");
  });

  test("the slot is released when the job calls done twice", async () => {
    const before = pool.stats().running;
    await pool.run((done) => {
      done(null, "first");
      done(null, "second"); // must be ignored
    });
    assert.equal(pool.stats().running, before, "a double-done must not leak a slot");
  });

  test("applies back-pressure: rejects instead of queueing without limit", async () => {
    const held = [];
    for (let i = 0; i < MAX; i++) {
      held.push(pool.run(() => () => {})); // never finishes on its own
    }
    // fill the queue
    const queued = [];
    for (let i = 0; i < pool.MAX_QUEUED; i++) {
      queued.push(pool.run(() => () => {}));
    }
    // one more must be rejected rather than accepted
    await assert.rejects(
      pool.run(() => () => {}),
      (e) => e.code === "FFMPEG_BUSY"
    );
    // drain everything so the pool is clean for the other tests
    held.forEach((p) => p.catch(() => {}));
    queued.forEach((p) => p.catch(() => {}));
    // force-drain by running short jobs until the counters settle
    for (let i = 0; i < 200; i++) {
      try { await pool.run((done) => setTimeout(() => done(null), 0)); } catch (e) { break; }
      if (pool.stats().running === 0 && pool.stats().waiting === 0) break;
    }
  });

  test("stats() exposes the configuration", () => {
    const s = pool.stats();
    assert.equal(s.maxRunning, MAX);
    assert.equal(s.maxQueued, pool.MAX_QUEUED);
    assert.equal(typeof s.running, "number");
  });
});
