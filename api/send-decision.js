// Sends a bid-decision notification by email. Runs on Vercel as a serverless function.
// Required environment variables (set in the Vercel project, never in this repository):
//   REGISTER_PASSWORD  the register password; requests must present it
//   SMTP_USER          mailbox that sends, e.g. bids@citiesforum.org
//   SMTP_PASS          that mailbox's app password
// Optional: SMTP_HOST (default smtp.gmail.com), SMTP_PORT (default 465), MAIL_FROM (default SMTP_USER),
//           ALLOWED_DOMAINS (comma-separated, default citiesforum.org) - who may sign in and who may receive.
const nodemailer = require("nodemailer");
const crypto = require("crypto");

const clean = (v, n) => String(v == null ? "" : v).replace(/[\r\n]+/g, " ").trim().slice(0, n);
const okAddr = (a) => /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(a);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const recent = new Map(); // best-effort throttle per sender while the function instance is warm

module.exports = async (req, res) => {
  const out = (code, body) => res.status(code).json(body);
  if (req.method !== "POST") return out(405, { error: "Use POST." });
  const env = process.env;
  if (!env.REGISTER_PASSWORD || !env.SMTP_USER || !env.SMTP_PASS)
    return out(503, { error: "Email sending is not set up yet. An administrator needs to add the mail settings in Vercel." });
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || typeof b !== "object") return out(400, { error: "Bad request." });
  if (!safeEq(b.password || "", env.REGISTER_PASSWORD)) return out(401, { error: "Sign in again: the register password was not accepted." });
  const domains = (env.ALLOWED_DOMAINS || "citiesforum.org").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const inDomain = (a) => domains.includes(a.toLowerCase().split("@").pop());
  const from = clean(b.user, 120).toLowerCase();
  if (!okAddr(from) || !inDomain(from)) return out(403, { error: "Your sign-in email is not allowed to send." });
  const to = (Array.isArray(b.to) ? b.to : []).map((a) => clean(a, 120).toLowerCase()).filter(Boolean);
  if (!to.length || to.length > 10) return out(400, { error: "Give between 1 and 10 recipient addresses." });
  const bad = to.find((a) => !okAddr(a) || !inDomain(a));
  if (bad) return out(400, { error: "Recipient not allowed: " + bad + ". Decisions can be sent to " + domains.map((d) => "@" + d).join(", ") + " addresses only." });
  const now = Date.now(), list = (recent.get(from) || []).filter((t) => now - t < 3600000);
  if (list.length >= 30) return out(429, { error: "Too many emails in the last hour. Try again later." });
  const d = b.decision || {}, o = b.opportunity || {};
  const rows = [
    ["Decision", clean(d.bid_decision, 40)], ["Internal owner", clean(d.internal_owner, 120)], ["Next action", clean(d.next_action_internal, 300) || "Not set"],
    ["Internal target date", clean(d.internal_target_date, 20) || "Not set"], ["Notes", String(d.user_notes || "").slice(0, 2000).trim() || "None"],
    ["Opportunity", clean(o.title, 300)], ["Client", clean(o.client, 200)], ["Country", clean(o.country, 80)], ["Reference", clean(o.reference, 80)],
    ["Type", clean(o.opportunity_type, 60)], ["Deadline as published", clean(o.deadline_original, 160)], ["UAE time", clean(o.deadline_uae, 80)],
    ["Recommended bidder", clean(o.recommended_bidder, 80)], ["Priority", clean(o.priority, 20)], ["Eligibility", clean(o.eligibility_status, 40)],
    ["Official notice", /^https?:\/\//.test(String(o.notice || "")) ? clean(o.notice, 400) : "Not verified"], ["Recorded by", from],
  ];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const subject = "Bid decision: " + (rows[0][1] || "Unassigned") + " | " + clean(o.title, 90);
  const text = "Bid decision recorded in the Cities Forum Consulting Bid Register.\n\n" + rows.map((r) => r[0] + ": " + r[1]).join("\n");
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#231F20;max-width:640px">' +
    '<div style="background:#067264;color:#fff;padding:14px 18px;font-size:17px;font-weight:bold">Bid decision: ' + esc(rows[0][1] || "Unassigned") + "</div>" +
    '<table cellpadding="7" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #D8E3E0">' +
    rows.map((r) => '<tr><td style="border-top:1px solid #D8E3E0;width:34%;font-weight:bold;color:#6D6E71;vertical-align:top">' + esc(r[0]) + '</td><td style="border-top:1px solid #D8E3E0;vertical-align:top">' + esc(r[1]).replace(/\n/g, "<br>") + "</td></tr>").join("") +
    '</table><p style="color:#6D6E71;font-size:12px">Sent from the Cities Forum Consulting Bid Register.</p></div>';
  try {
    const port = Number(env.SMTP_PORT || 465);
    const tx = nodemailer.createTransport({ host: env.SMTP_HOST || "smtp.gmail.com", port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
    const info = await tx.sendMail({ from: '"Cities Forum Bid Register" <' + (env.MAIL_FROM || env.SMTP_USER) + ">", to, replyTo: from, subject, text, html });
    list.push(now); recent.set(from, list);
    return out(200, { ok: true, to, id: info.messageId || "" });
  } catch (e) {
    return out(502, { error: "The mail server refused the message (" + clean(e && (e.code || e.message), 120) + "). Check the mail settings in Vercel." });
  }
};
