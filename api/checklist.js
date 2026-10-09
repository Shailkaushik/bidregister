// Bid checklist files: one Excel file per bid that anyone signed in can upload (replacing the old one) and download.
// Files go in the Vercel Blob store under checklists/; the list of who uploaded what is data/checklists.json.
//
// GET  /api/checklist                      header X-Register-Key  -> {ok, items: {id: {name,size,uploaded_by,uploaded_at,path}}}
// GET  /api/checklist?id=<bid id>          header X-Register-Key  -> the file itself, as a download
// POST /api/checklist?id=<bid id>&name=<file name>   headers X-Register-Key, X-User; the body is the raw file
// Only Excel workbooks are accepted (.xlsx or .xls, checked by name and by file contents), up to 4 MB.
const { get, del } = require("@vercel/blob");
const { clean, hasStore, okAddr, inDomain, okPassword, readBlob, writeBlob, putAccess, isPrecondition } = require("./_common");

const META = "data/checklists.json";
const MAX = 4 * 1024 * 1024;
const TYPE = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel" };

// Real workbook check: .xlsx is a zip that holds xl/workbook.xml; .xls is an old-style Office (OLE) file.
function kind(buf, ext) {
  if (ext === "xlsx") return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf.includes("xl/workbook.xml") ? "xlsx" : null;
  if (ext === "xls") return buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) ? "xls" : null;
  return null;
}
async function loadMeta() {
  const r = await readBlob(META);
  if (!r) return { items: {}, etag: null };
  try { const j = JSON.parse(r.text); return { items: j && j.items && typeof j.items === "object" ? j.items : {}, etag: r.etag }; } catch (e) { return { items: {}, etag: r.etag }; }
}
async function readFile(pathname) {
  for (const access of ["private", "public"]) {
    try { const r = await get(pathname, { access, useCache: false }); if (r && r.stream) return Buffer.from(await new Response(r.stream).arrayBuffer()); } catch (e) {}
  }
  return null;
}
const saveFile = (path, buf, contentType) => putAccess(path, buf, { addRandomSuffix: true, contentType });

module.exports = async (req, res) => {
  const out = (code, body) => { res.setHeader("Cache-Control", "no-store"); return res.status(code).json(body); };
  if (!hasStore()) return out(503, { error: "No storage is connected to the site." });
  try {
    if (!okPassword(String(req.headers["x-register-key"] || ""))) return out(401, { error: "Not authorised." });
    const q = req.query || {};
    const id = clean(q.id, 220);
    if (req.method === "GET") {
      const { items } = await loadMeta();
      if (!id) return out(200, { ok: true, items });
      const m = items[id];
      if (!m) return out(404, { error: "No checklist has been uploaded for this bid." });
      const buf = await readFile(m.path);
      if (!buf) return out(404, { error: "The checklist file could not be found." });
      const ext = /\.xls$/i.test(m.name) ? "xls" : "xlsx";
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", TYPE[ext]);
      res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(m.name));
      return res.status(200).send(buf);
    }
    if (req.method !== "POST") return out(405, { error: "Use GET or POST." });
    const by = clean(req.headers["x-user"], 120).toLowerCase();
    if (!okAddr(by) || !inDomain(by)) return out(403, { error: "Your sign-in email is not allowed to upload." });
    if (!id) return out(400, { error: "Missing bid id." });
    const name = clean(q.name, 150).replace(/[\\/:*?"<>|]+/g, "_");
    const ext = ((/\.([A-Za-z0-9]+)$/.exec(name) || [])[1] || "").toLowerCase();
    if (!TYPE[ext]) return out(400, { error: "Only Excel files (.xlsx or .xls) can be uploaded." });
    const body = req.body;
    if (!Buffer.isBuffer(body)) return out(400, { error: "Send the file as the request body." });
    if (body.length > MAX) return out(413, { error: "The file is larger than 4 MB." });
    if (!kind(body, ext)) return out(400, { error: "That file is not a real Excel workbook." });
    const saved = await saveFile("checklists/" + Date.now() + "-" + ext, body, TYPE[ext]);
    const now = new Date().toISOString();
    let old = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { items, etag } = await loadMeta();
      old = items[id] ? items[id].path : null;
      items[id] = { name, size: body.length, uploaded_by: by, uploaded_at: now, path: saved.pathname };
      try { await writeBlob(META, JSON.stringify({ updated_at: now, items }), etag && attempt < 3 ? { ifMatch: etag } : {}); break; }
      catch (e) { if (!isPrecondition(e) || attempt === 4) throw e; }
    }
    if (old && old !== saved.pathname) { try { await del(old); } catch (e) {} } // the replaced file
    const { items } = await loadMeta();
    return out(200, { ok: true, items });
  } catch (e) {
    return out(502, { error: "Storage refused the request (" + clean(e && e.name, 60) + ": " + clean(e && e.message, 200) + ")." });
  }
};
