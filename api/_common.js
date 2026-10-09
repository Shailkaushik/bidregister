// Shared helpers for the register's API functions (files starting with _ are not served as routes).
const crypto = require("crypto");
const { put, get, BlobPreconditionFailedError } = require("@vercel/blob");
const AUTH = require("./_auth.json"); // salted PBKDF2 hash of the register password, written by the build

const clean = (v, n) => String(v == null ? "" : v).replace(/[\r\n]+/g, " ").trim().slice(0, n);
const hasStore = () => !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
const DOMAINS = () => String(process.env.ALLOWED_DOMAINS || AUTH.domains || "citiesforum.org").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const okAddr = (a) => /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(a);
const inDomain = (a) => DOMAINS().includes(a.toLowerCase().split("@").pop());

function okPassword(pw) {
  if (typeof pw !== "string" || !pw || pw.length > 200) return false;
  const h = crypto.pbkdf2Sync(pw, Buffer.from(AUTH.salt, "base64"), AUTH.iter, 32, "sha256");
  const want = Buffer.from(AUTH.hash, "base64");
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
// The store may have been created as private or public; use whichever it accepts.
async function readBlob(pathname) {
  for (const access of ["private", "public"]) {
    try {
      const r = await get(pathname, { access, useCache: false });
      if (r && r.stream) return { text: await new Response(r.stream).text(), etag: (r.blob && r.blob.etag) || null };
    } catch (e) {}
  }
  return null;
}
// Blob errors carry no useful `name`, so recognise the two cases we care about from the class and message.
const isPrecondition = (e) => !!e && (e instanceof BlobPreconditionFailedError || /precondition failed|etag mismatch/i.test(String(e.message)));
const isAccessMismatch = (e) => !!e && /(public|private) (access|store)|configured with (public|private)/i.test(String(e.message));
// Try private access first; only switch to public when the store itself says the access type is wrong.
// Any other failure is reported as it is, never hidden behind a second attempt.
async function putAccess(pathname, body, opts) {
  try { return await put(pathname, body, { ...opts, access: "private" }); }
  catch (e) { if (!isAccessMismatch(e)) throw e; return await put(pathname, body, { ...opts, access: "public" }); }
}
async function writeBlob(pathname, body, extra) {
  return putAccess(pathname, body, { addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", ...(extra || {}) });
}
module.exports = { AUTH, clean, hasStore, okAddr, inDomain, okPassword, readBlob, writeBlob, putAccess, isPrecondition };
