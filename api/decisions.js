// Decision outbox for the bid register. Runs on Vercel as a serverless function; needs a Vercel Blob store
// connected to the project (that adds BLOB_READ_WRITE_TOKEN automatically). No other settings are required.
//
// POST /api/decisions                      queue a decision email (called by the register page)
// GET  /api/decisions?key=PASSWORD         list queued emails (read by the Claude task that sends them)
// GET  /api/decisions?key=PASSWORD&ack=a,b remove queued emails after they were sent
//
// Sending: if SMTP_USER and SMTP_PASS are set in the Vercel project (optional SMTP_HOST, SMTP_PORT, MAIL_FROM;
// defaults are Gmail), the decision email is sent at once from that mailbox. If they are not set, or the mail
// server refuses, the decision is queued in the Blob store and a scheduled Claude task sends it within the hour.
const crypto = require("crypto");
const { put, list, get, del } = require("@vercel/blob");
const nodemailer = require("nodemailer");
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

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function sendNow(item) {
  const env = process.env, d = item.decision, o = item.opportunity;
  const rows = [["Decision", d.bid_decision || "Unassigned"], ["Internal owner", d.internal_owner || "Unassigned"], ["Next action", d.next_action_internal || "Not set"],
    ["Internal target date", d.internal_target_date || "Not set"], ["Notes", d.user_notes || "None"], ["Opportunity", o.title], ["Client", o.client], ["Country", o.country],
    ["Reference", o.reference], ["Type", o.opportunity_type], ["Deadline as published", o.deadline_original], ["UAE time", o.deadline_uae],
    ["Recommended bidder", o.recommended_bidder], ["Priority", o.priority], ["Eligibility", o.eligibility_status], ["Official notice", o.notice || "Not verified"], ["Recorded by", item.recorded_by]];
  const subject = "Bid decision: " + rows[0][1] + " | " + clean(o.title, 90);
  const text = "Bid decision recorded in the Cities Forum Consulting Bid Register.\n\n" + rows.map((r) => r[0] + ": " + r[1]).join("\n");
  const cell = (r) => r[0] === "Official notice" && /^https?:\/\//.test(r[1]) ? '<a href="' + esc(r[1]) + '">' + esc(r[1]) + "</a>" : esc(r[1]).replace(/\n/g, "<br>");
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#231F20;max-width:640px">' +
    '<div style="background:#067264;color:#fff;padding:14px 18px;font-size:17px;font-weight:bold">Bid decision: ' + esc(rows[0][1]) + "</div>" +
    '<table cellpadding="7" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #D8E3E0">' +
    rows.map((r) => '<tr><td style="border-top:1px solid #D8E3E0;width:34%;font-weight:bold;color:#6D6E71;vertical-align:top">' + esc(r[0]) + '</td><td style="border-top:1px solid #D8E3E0;vertical-align:top">' + cell(r) + "</td></tr>").join("") +
    '</table><p style="color:#6D6E71;font-size:12px">Sent from the Cities Forum Consulting Bid Register.</p></div>';
  const port = Number(env.SMTP_PORT || 465);
  const tx = nodemailer.createTransport({ host: env.SMTP_HOST || "smtp.gmail.com", port, secure: port === 465, auth: { user: env.SMTP_USER, pass: String(env.SMTP_PASS).replace(/\s+/g, "") } });
  return tx.sendMail({ from: '"Cities Forum Bid Register" <' + (env.MAIL_FROM || env.SMTP_USER) + ">", to: item.to, replyTo: item.recorded_by, subject, text, html });
}

module.exports = async (req, res) => {
  const out = (code, body) => { res.setHeader("Cache-Control", "no-store"); return res.status(code).json(body); };
  // A connected store provides either BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID (token-less access); names may carry a custom prefix.
  const blobVars = Object.keys(process.env).filter((k) => /BLOB/.test(k));
  const hasStore = !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
  const hasMail = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
  if (!hasStore && !(hasMail && req.method === "POST"))
    return out(503, { error: "Decision emails are not switched on yet: the site has no mail settings and no storage connected.", storage_settings_seen: blobVars });
  try {
    if (req.method === "GET") {
      const q = req.query || {};
      if (!okPassword(q.key)) return out(401, { error: "Not authorised." });
      if (q.check === "mail") { // sign in to the mail server without sending anything
        if (!hasMail) return out(200, { ok: true, mail: "not configured", storage: hasStore });
        try {
          const port = Number(process.env.SMTP_PORT || 465);
          await nodemailer.createTransport({ host: process.env.SMTP_HOST || "smtp.gmail.com", port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s+/g, "") } }).verify();
          return out(200, { ok: true, mail: "login accepted", sender: process.env.SMTP_USER, storage: hasStore });
        } catch (e) { return out(200, { ok: true, mail: "login refused", sender: process.env.SMTP_USER, reason: clean(e && (e.code || e.message), 60) + (e && e.response ? ": " + clean(e.response, 200) : ""), storage: hasStore }); }
      }
      if (!hasStore) return out(200, { ok: true, count: 0, more: false, items: [] });
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
    let mailError = "";
    if (hasMail) {
      try { const info = await sendNow(item); return out(200, { ok: true, sent: true, to, id: (info && info.messageId) || "" }); }
      catch (e) { mailError = clean(e && (e.code || e.responseCode || e.message), 80) + (e && e.response ? ": " + clean(e.response, 160) : ""); }
    }
    if (!hasStore) return out(502, { error: "The mail server refused the message (" + mailError + ") and there is no queue to fall back on." });
    const pending = (await list({ prefix: "outbox/", limit: 200 })).blobs.length;
    if (pending >= 150) return out(429, { error: "Too many decision emails are waiting to be sent. Try again later." });
    await save("outbox/" + Date.now() + ".json", JSON.stringify(item));
    return out(200, { ok: true, queued: true, to, mail_error: mailError });
  } catch (e) {
    return out(502, { error: "The site's storage refused the request (" + clean(e && e.name, 60) + ": " + clean(e && e.message, 200) + ").", storage_settings_seen: blobVars });
  }
};
