// Bid data API for the register. Runs on Vercel; uses the same Vercel Blob store as decisions.js.
//
// GET  /api/bids   returns the ENCRYPTED register data (same envelope the page used to carry inline:
//                  {iter, iv, ct, wraps, domain, stamp}). Only ciphertext is served; the browser decrypts it
//                  with the register password, so nothing readable is ever public.
// POST /api/bids   replace the data. Body is JSON, sent by the daily pipeline run, with the register password:
//                    {"password": "...", "state": <pipeline.json>}   the server encrypts it under that password, or
//                    {"password": "...", "envelope": {...}}          an envelope already built (e.g. several passwords).
//
// The password is checked against the salted hash in _auth.json. It is never stored.
const crypto = require("crypto");
const { AUTH, clean, okPassword, readBlob, writeBlob } = require("./_common");

const PATH = "data/bids.json";
const ITER = 600000;
const b64 = (buf) => Buffer.from(buf).toString("base64");

function gcm(key, iv, plain) {
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]); // WebCrypto layout: ciphertext followed by the 16-byte tag
}
// Same scheme as build_standalone.py: random data key encrypts the data, each password wraps that key.
function encrypt(state, password) {
  const dek = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const ct = gcm(dek, iv, Buffer.from(JSON.stringify(state), "utf8"));
  const salt = crypto.randomBytes(16), wiv = crypto.randomBytes(12);
  const kek = crypto.pbkdf2Sync(password, salt, ITER, 32, "sha256");
  return { iter: ITER, iv: b64(iv), ct: b64(ct), wraps: [{ salt: b64(salt), iv: b64(wiv), ct: b64(gcm(kek, wiv, dek)) }], domain: String(AUTH.domains || "citiesforum.org").split(",")[0].trim().toLowerCase() };
}
function stampOf(state) {
  const run = ((state.runs || []).slice(-1)[0] || {}).finished;
  const d = run ? new Date(run) : new Date();
  if (isNaN(d)) return "";
  const u = new Date(d.getTime() + 4 * 3600000), M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], p = (n) => String(n).padStart(2, "0");
  return p(u.getUTCDate()) + " " + M[u.getUTCMonth()] + " " + u.getUTCFullYear() + ", " + p(u.getUTCHours()) + ":" + p(u.getUTCMinutes()) + " UAE";
}
const validEnvelope = (e) => e && typeof e === "object" && e.iter > 0 && typeof e.iv === "string" && typeof e.ct === "string" && Array.isArray(e.wraps) && e.wraps.length > 0 &&
  e.wraps.every((w) => w && typeof w.salt === "string" && typeof w.iv === "string" && typeof w.ct === "string");

async function readStored() { const r = await readBlob(PATH); return r && r.text; }
const store = (body) => writeBlob(PATH, body);

module.exports = async (req, res) => {
  const out = (code, body) => { res.setHeader("Cache-Control", "no-store"); return res.status(code).json(body); };
  if (!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID)) return out(503, { error: "No storage is connected to the site." });
  try {
    if (req.method === "GET") {
      const t = await readStored();
      if (!t) return out(404, { error: "No data has been published yet." });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(t);
    }
    if (req.method !== "POST") return out(405, { error: "Use GET or POST." });
    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
    if (!b || typeof b !== "object") return out(400, { error: "Bad request." });
    if (!okPassword(b.password)) return out(401, { error: "Password not accepted." });
    let env, count = null;
    if (b.envelope) {
      if (!validEnvelope(b.envelope)) return out(400, { error: "The envelope is not in the expected format." });
      env = { iter: b.envelope.iter, iv: b.envelope.iv, ct: b.envelope.ct, wraps: b.envelope.wraps, domain: clean(b.envelope.domain || AUTH.domains, 60).toLowerCase() };
      env.stamp = clean(b.stamp, 40);
    } else {
      const s = b.state;
      if (!s || typeof s !== "object" || !s.opportunities || typeof s.opportunities !== "object") return out(400, { error: "Send {password, state} where state is pipeline.json with an opportunities object." });
      const state = { ...s }; delete state.sources; delete state.deliveries; // not shown on the register
      count = Object.keys(state.opportunities).length;
      env = encrypt(state, b.password);
      env.stamp = stampOf(state);
    }
    env.updated_at = new Date().toISOString();
    await store(JSON.stringify(env));
    return out(200, { ok: true, stamp: env.stamp, records: count, updated_at: env.updated_at });
  } catch (e) {
    return out(502, { error: "Storage refused the request (" + clean(e && e.name, 60) + ": " + clean(e && e.message, 200) + ")." });
  }
};
