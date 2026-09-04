/* Live test: upload receipt images via /api/uploads with purpose=payment_receipt.
   A clean image must be accepted; an edited/tampered image must be rejected. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BASE = "http://localhost:5000";
const ADMIN_EMAIL = "admin@manara.app";
const ADMIN_PASS = "AAMzTqUix%GFxa8DYS";

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: "localhost", port: 5000, path: p, headers: { "Content-Type": "application/json" } };
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const r = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, data: j, raw: d }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function upload(purpose, filePath, token) {
  return new Promise((resolve, reject) => {
    const boundary = "----manara" + Date.now();
    const content = fs.readFileSync(filePath);
    const name = path.basename(filePath);
    const mime = /\.txt$/i.test(name) ? "text/plain" : "image/png";
    const crlf = "\r\n";
    let head = "--" + boundary + crlf;
    head += 'Content-Disposition: form-data; name="purpose"' + crlf + crlf + purpose + crlf;
    head += "--" + boundary + crlf;
    head += 'Content-Disposition: form-data; name="file"; filename="' + name + '"' + crlf;
    head += "Content-Type: " + mime + crlf + crlf;
    let tail = crlf + "--" + boundary + "--" + crlf;
    const body = Buffer.concat([Buffer.from(head, "latin1"), content, Buffer.from(tail, "latin1")]);
    const opts = {
      method: "POST", hostname: "localhost", port: 5000, path: "/api/upload",
      headers: {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": body.length,
        "Authorization": "Bearer " + token
      }
    };
    const r = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, data: j, raw: d }); });
    });
r.on("error", reject);
    r.write(body);
    r.end();
  });
}

function makePng(w, h) {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const o = off + 1 + x * 3;
      raw[o] = Math.floor(rnd() * 256); raw[o + 1] = Math.floor(rnd() * 256); raw[o + 2] = Math.floor(rnd() * 256);
    }
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    let c = 0xffffffff;
    for (const b of Buffer.concat([t, data])) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let cc = n; for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1; crcTable[n] = cc >>> 0; }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))
  ]);
}

async function run() {
  console.log("\n=== Live receipt-upload integration test ===\n");

  const login = await req("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASS });
  ok("admin login", login.status === 200, login);
  const token = login.data.token;

  const dir = require("path").join(__dirname, "..", "uploads");
  const clean = path.join(dir, "live_clean.png");
  const edited = path.join(dir, "live_edited.png");
  fs.writeFileSync(clean, makePng(800, 800));
  fs.writeFileSync(edited, Buffer.concat([makePng(800, 800), Buffer.from("tEXtSoftwareGimp", "latin1")]));

  const rClean = await upload("payment_receipt", clean, token);
  ok("clean receipt accepted (201)", rClean.status === 201 && rClean.data.files && rClean.data.files[0], rClean);
  if (rClean.status === 201) {
    const url = rClean.data.files[0].url;
    ok("clean receipt returns URL", !!url && /^\/uploads\//.test(url));
  }

  const rEdited = await upload("payment_receipt", edited, token);
  ok("edited receipt rejected (4xx)", rEdited.status >= 400 && rEdited.status < 500, rEdited);
  ok("rejection mentions tampering", /تعديل|غير صالح|مزيف|رفض|إيصال/i.test(rEdited.raw || ""), rEdited.raw);

  // non-image (text) receipt
  const fake = path.join(dir, "live_fake.txt");
  fs.writeFileSync(fake, "not an image at all - just text content that is long enough to pass size checks ".repeat(300));
  const rFake = await upload("payment_receipt", fake, token);
  ok("non-image receipt rejected (4xx)", rFake.status >= 400 && rFake.status < 500, rFake);

  // cleanup files
  [clean, edited, fake].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });

  console.log("\n=== RESULT: " + passed + " passed, " + failed + " failed ===\n");
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error("Test crashed:", e); process.exit(1); });