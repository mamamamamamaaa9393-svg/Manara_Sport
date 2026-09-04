/* ==========================================================================
   Manara — Kashier payment gateway client.
   Modern "Payment Sessions" integration (v3):
     - createSession()  : server-side payment session -> secure checkout URL
     - verifyWebhookSignature() : HMAC-SHA256 validation of webhook payloads
   All credentials come from environment variables — never exposed to the
   client (the frontend only ever receives the checkout sessionUrl).
   ========================================================================== */
const crypto = require("crypto");

const MODE = String(process.env.KASHIER_MODE || "test").toLowerCase();
const API_KEY = String(process.env.KASHIER_API_KEY || "");
const SECRET_KEY = String(process.env.KASHIER_SECRET_KEY || "");
const MERCHANT_ID = String(process.env.KASHIER_MERCHANT_ID || "");
const CURRENCY = String(process.env.KASHIER_CURRENCY || "EGP");
const IS_TEST = MODE !== "live";

const API_BASE = IS_TEST ? "https://test-api.kashier.io" : "https://api.kashier.io";

function enabled() {
  return !!(API_KEY && SECRET_KEY && MERCHANT_ID);
}

/* Create a one-time payment session (card + wallets) for `amount` (EGP).
   Returns { sessionUrl, _id, status, ... } from Kashier. Throws on failure. */
async function createSession(opts) {
  if (!enabled()) {
    throw new Error("Kashier is not configured — set KASHIER_API_KEY / KASHIER_SECRET_KEY / KASHIER_MERCHANT_ID");
  }

  const body = {
    merchantId: MERCHANT_ID,
    amount: Number(opts.amount).toFixed(2),
    currency: opts.currency || CURRENCY,
    order: opts.order,
    paymentType: "credit",
    type: "one-time",
    allowedMethods: "card,wallet",
    display: opts.display || "ar",
    merchantRedirect: opts.redirectUrl,
    serverWebhook: opts.webhookUrl,
    description: opts.description || "اشتراك منارة الشهري",
    customer: {
      email: opts.email || "",
      reference: String(opts.reference != null ? opts.reference : "")
    },
    metaData: {
      source: "manara",
      order: opts.order
    }
  };

  const res = await fetch(API_BASE + "/v3/payment/sessions", {
    method: "POST",
    headers: {
      "Authorization": SECRET_KEY,
      "api-key": API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || ("Kashier request failed (" + res.status + ")"));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* Validate a Kashier webhook/callback signature.
   Per Kashier docs: sort data.signatureKeys alphabetically, build the query
   string of those key=value pairs (RFC3986 encoding, PHP http_build_query
   semantics) and HMAC-SHA256 it with the Payment API key.
   SECURITY: the caller-supplied signatureKeys list must cover the fields the
   payment decision depends on (amount, currency, status, order, transaction).
   Otherwise an attacker could replay a legitimately-signed payload with
   UNSIGNED decision fields rewritten (status SUCCESS / bigger amount) and the
   signature would still validate. The comparison is constant-time. */
const REQUIRED_SIGNED_KEYS = ["merchantOrderId", "amount", "currency", "transactionId", "status"];
function verifyWebhookSignature(body, receivedSignature) {
  if (!receivedSignature || !body || !body.data) return false;
  const data = body.data;
  if (!Array.isArray(data.signatureKeys) || !data.signatureKeys.length) return false;

  // Every decision field MUST be inside the signed set — reject otherwise.
  for (const required of REQUIRED_SIGNED_KEYS) {
    if (data.signatureKeys.indexOf(required) === -1) return false;
  }

  // FIX: only sign the required fields, not arbitrary client-chosen keys.
  // This prevents attackers from omitting 'amount' or 'status' from the signed
  // payload while still getting the signature to validate, then forging the
  // payment decision based on those unsigned fields.
  const signedKeys = data.signatureKeys.filter((k) => REQUIRED_SIGNED_KEYS.indexOf(k) !== -1).sort();
  const pairs = signedKeys.map((k) => {
    const v = data[k];
    if (v == null) return null;
    return encodeURIComponent(k) + "=" + encodeURIComponent(String(v));
  }).filter(Boolean);

  const payload = pairs.join("&");
  const expected = crypto.createHmac("sha256", API_KEY).update(payload).digest("hex");
  const got = String(receivedSignature);
  if (expected.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch (e) {
    return false;
  }
}

/* Query a session's live status from Kashier (self-healing when a webhook
   is lost / never delivered). Kashier responds with:
     200  { status:"OPENED", ... }                 -> not paid yet (or abandoned)
     400  { status:"FAILURE", messages:{ ar:"لقد تم دفع الطلب بالفعل" } }
                                                   -> payment already succeeded
   Returns { paid, data }. Throws on unexpected responses. */
async function getSessionStatus(sessionId) {
  if (!sessionId) return { paid: false, data: null };
  const res = await fetch(API_BASE + "/v3/payment/sessions/" + encodeURIComponent(sessionId), {
    headers: {
      "Authorization": SECRET_KEY,
      "api-key": API_KEY
    }
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 200) return { paid: false, data };
  const msg = String((data.messages && (data.messages.en || data.messages.ar)) || "").toLowerCase();
  if (res.status === 400 && /already been paid|تم دفع الطلب/.test(msg)) {
    return { paid: true, data };
  }
  throw new Error("Kashier session query failed (" + res.status + "): " + msg.slice(0, 120) || res.status);
}

module.exports = {
  MODE,
  IS_TEST,
  API_BASE,
  enabled,
  createSession,
  verifyWebhookSignature,
  getSessionStatus
};