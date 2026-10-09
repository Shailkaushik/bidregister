// Shared bid decisions (decision, owner, next action, target date, notes) so every signed-in user sees the same ones.
// Stored as one JSON file in the Vercel Blob store (data/decisions.json), keyed by opportunity id.
//
// GET  /api/decisions                header X-Register-Key: <password>   -> {ok, items: {id: decision}}
// POST /api/decisions                {password, user, items: {id: decision}}   save one or more decisions
//        add "import": true to keep the decisions' own updated_at (used to push older local copies up);
//        otherwise the server stamps the save time. The newest save per opportunity wins.
const { clean, hasStore, okAddr, inDomain, okPassword, readBlob, writeBlob } = require("./_common");

const PATH = "data/decisions.json";
const OPTIONS = ["Unassigned", "Bid", "No bid", "Watch", "Partner search"];

function tidy(d, by, at) {
  d = d && typeof d === "object" ? d : {};
  const bid = OPTIONS.includes(d.bid_decision) ? d.bid_decision : "Unassigned";
  return { bid_decision: bid, internal_owner: clean(d.internal_owner, 120) || "Unassigned", next_action_internal: clean(d.next_action_internal, 300),
    internal_target_date: /^\d{4}-\d{2}-\d{2}$/.test(String(d.internal_target_date || "")) ? d.internal_target_date : "",
    user_notes: String(d.user_notes || "").slice(0, 2000).trim(), updated_at: at, updated_by: by };
}
async function load() {
  const r = await readBlob(PATH);
  if (!r) return { items: {}, etag: null };
  try { const j = JSON.parse(r.text); return { items: j && typeof j.items === "object" && j.items ? j.items : {}, etag: r.etag }; } catch (e) { return { items: {}, etag: r.etag }; }
}

module.exports = async (req, res) => {
  const out = (code, body) => { res.setHeader("Cache-Control", "no-store"); return res.status(code).json(body); };
  if (!hasStore()) return out(503, { error: "No storage is connected to the site." });
  try {
    if (req.method === "GET") {
      if (!okPassword(String(req.headers["x-register-key"] || ""))) return out(401, { error: "Not authorised." });
      const { items } = await load();
      return out(200, { ok: true, items });
    }
    if (req.method !== "POST") return out(405, { error: "Use GET or POST." });
    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
    if (!b || typeof b !== "object") return out(400, { error: "Bad request." });
    if (!okPassword(b.password)) return out(401, { error: "Sign in again: the register password was not accepted." });
    const by = clean(b.user, 120).toLowerCase();
    if (!okAddr(by) || !inDomain(by)) return out(403, { error: "Your sign-in email is not allowed to save." });
    const ids = Object.keys(b.items && typeof b.items === "object" ? b.items : {});
    if (!ids.length || ids.length > 500) return out(400, { error: "Send between 1 and 500 decisions." });
    if (ids.some((k) => !k || k.length > 220)) return out(400, { error: "Bad opportunity id." });
    const now = new Date().toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { items, etag } = await load();
      let changed = 0;
      for (const k of ids) {
        const inc = b.items[k] || {};
        let at = now;
        if (b.import === true) { const t = Date.parse(inc.updated_at); at = !isNaN(t) && t <= Date.now() ? new Date(t).toISOString() : now; }
        if (!items[k] || String(items[k].updated_at || "") <= at) { items[k] = tidy(inc, b.import === true ? clean(inc.updated_by, 120).toLowerCase() || by : by, at); changed++; }
      }
      if (!changed) return out(200, { ok: true, saved: 0, items });
      try {
        await writeBlob(PATH, JSON.stringify({ updated_at: now, items }), etag ? { ifMatch: etag } : {});
        return out(200, { ok: true, saved: changed, items });
      } catch (e) { if (!(e && e.name === "BlobPreconditionFailedError")) throw e; } // someone saved at the same moment: read again and retry
    }
    return out(409, { error: "Several people saved at the same moment. Please save again." });
  } catch (e) {
    return out(502, { error: "Storage refused the request (" + clean(e && e.name, 60) + ": " + clean(e && e.message, 200) + ")." });
  }
};
