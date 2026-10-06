// Decision outbox for the bid register. Runs on Vercel as a serverless function; needs a Vercel Blob store
// connected to the project (that adds BLOB_READ_WRITE_TOKEN automatically). No other settings are required.
//
// POST /api/decisions                      queue a decision email (called by the register page)
// GET  /api/decisions?key=PASSWORD         list queued emails (read by the Claude task that sends them)
// GET  /api/decisions?key=PASSWORD&ack=a,b remove queued emails after they were sent
//
// Emails are sent later from business@citiesforum.org by a scheduled Claude task, not by this function.
const crypto = require("crypto");
const { put, list, get, del } = require("@vercel/blob");
const AUTH = require("./_auth.json"); // salted PBKDF2 hash of the register password, written by the build

const DOMAINS = (process.env.ALLOWED_DOMAINS || AUTH.domains || "citiesforum.org").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const clean = (v, n) => String(v == null ? "" : v).replace(/[\r\n]+/g, " ").trim().slice(0, n);
const okAddr = (a) => /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(a);
const inDomain = (a) => DOMAINS.includes(a.toLowerCase().split("@").pop());
function okPassword(pw) {
  if (typeof pw !== "string" || !pw || pw.length > 200) return false;
  const h = crypto.pbkdf2Sync(pw, Buffer.from(AUTH.salt, "base64"), AUTH.iter, 32, "sha256");
  const want = Buffer.from(AUTH.hash, "base64");
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
// The store may have been created as private or public; use whichever it accepts.
async function save(path, body) {
  try { return await put(path, body, { access: "private", addRandomSuffix: true, contentType: "application/json" }); }
  catch (e) { return await put(path, body, { access: "public", addRandomSuffix: true, contentType: "application/json" }); }
}
async function read(pathname) {
  for (const access of ["private", "public"]) {
    try { const r = await get(pathname, { access, useCache: false }); if (r && r.stream) return await new Response(r.stream).text(); } catch (e) {}
  }
  return null;
}

module.exports = async (req, res) => {
  const out = (code, body) => { res.setHeader("Cache-Control", "no-store"); return res.status(code).json(body); };
  // A connected store provides either BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID (token-less access); names may carry a custom prefix.
  const blobVars = Object.keys(process.env).filter((k) => /BLOB/.test(k));
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID)
    return out(503, { error: "Decision emails are not switched on yet: the site has no storage connected.", storage_settings_seen: blobVars });
  try {
    if (req.method === "GET") {
      const q = req.query || {};
      if (!okPassword(q.key)) return out(401, { error: "Not authorised." });
      const found = (await list({ prefix: "outbox/", limit: 200 })).blobs;
      if (q.ack) {
        const names = String(q.ack).split(",").map((s) => s.trim()).filter(Boolean);
        const gone = found.filter((b) => names.includes(b.pathname.replace(/^outbox\//, "").replace(/\.json$/, "")));
        if (gone.length) await del(gone.map((b) => b.url));
        return out(200, { ok: true, removed: gone.length, remaining: found.length - gone.length });
      }
      const items = [];
      for (const b of found.slice(0, 40)) {
        const t = await read(b.pathname);
        if (t) { try { const j = JSON.parse(t); j.name = b.pathname.replace(/^outbox\//, "").replace(/\.json$/, ""); items.push(j); } catch (e) {} }
      }
      return out(200, { ok: true, count: items.length, more: found.length > items.length, items });
    }
    if (req.method !== "POST") return out(405, { error: "Use POST." });
    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
    if (!b || typeof b !== "object") return out(400, { error: "Bad request." });
    if (!okPassword(b.password)) return out(401, { error: "Sign in again: the register password was not accepted." });
    const from = clean(b.user, 120).toLowerCase();
    if (!okAddr(from) || !inDomain(from)) return out(403, { error: "Your sign-in email is not allowed to send." });
    const to = [...new Set((Array.isArray(b.to) ? b.to : []).map((a) => clean(a, 120).toLowerCase()).filter(Boolean))];
    if (!to.length || to.length > 10) return out(400, { error: "Give between 1 and 10 recipient addresses." });
    const bad = to.find((a) => !okAddr(a) || !inDomain(a));
    if (bad) return out(400, { error: "Recipient not allowed: " + bad + ". Decisions can be sent to " + DOMAINS.map((d) => "@" + d).join(", ") + " addresses only." });
    const pending = (await list({ prefix: "outbox/", limit: 200 })).blobs.length;
    if (pending >= 150) return out(429, { error: "Too many decision emails are waiting to be sent. Try again later." });
    const d = b.decision || {}, o = b.opportunity || {};
    const item = {
      queued_at: new Date().toISOString(), recorded_by: from, to,
      opportunity_id: clean(b.opportunity_id, 220),
      decision: { bid_decision: clean(d.bid_decision, 40), internal_owner: clean(d.internal_owner, 120), next_action_internal: clean(d.next_action_internal, 300),
        internal_target_date: clean(d.internal_target_date, 20), user_notes: String(d.user_notes || "").slice(0, 2000).trim() },
      opportunity: { title: clean(o.title, 300), client: clean(o.client, 200), country: clean(o.country, 80), reference: clean(o.reference, 80),
        opportunity_type: clean(o.opportunity_type, 60), deadline_original: clean(o.deadline_original, 160), deadline_uae: clean(o.deadline_uae, 80),
        recommended_bidder: clean(o.recommended_bidder, 80), priority: clean(o.priority, 20), eligibility_status: clean(o.eligibility_status, 40),
        notice: /^https?:\/\//.test(String(o.notice || "")) ? clean(o.notice, 400) : "" },
    };
    await save("outbox/" + Date.now() + ".json", JSON.stringify(item));
    return out(200, { ok: true, queued: true, to });
  } catch (e) {
    return out(502, { error: "The site's storage refused the request (" + clean(e && e.name, 60) + ": " + clean(e && e.message, 200) + ").", storage_settings_seen: blobVars });
  }
};
