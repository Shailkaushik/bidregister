# Consulting Bid Register

Static bid register for Cities Forum. It also carries opportunities screened for Katha Media. No build step: the site is `index.html`.

- `index.html`: the register page. The data inside it is encrypted; the page asks for a Cities Forum email address and the shared password, then decrypts in the browser.
- There is deliberately no plain data file in this repository. Do not add one: anything here is served publicly by the host.
- `vercel.json`, `netlify.toml`: ask search engines not to index the site. They are not access control; protect the site on the host.

## Bid data API

`api/bids.js` is a Vercel function that serves the register data, so the daily run no longer has to rebuild and commit `index.html`.

- `GET /api/bids` returns the data **encrypted** (same envelope as before: `iter, iv, ct, wraps, domain, stamp`). The page fetches it on sign-in and decrypts it in the browser with the password. The copy embedded in `index.html` is only a fallback if the API is unreachable or its data cannot be opened.
- `POST /api/bids` replaces the data. The daily run sends `{"password": "<register password>", "state": <pipeline.json>}`; the server drops `sources` and `deliveries`, encrypts under that password and stores it in the Blob store (`data/bids.json`). It can instead send `{"password": ..., "envelope": {...}, "stamp": "..."}` for data already encrypted (for example under several passwords). The password is checked against the hash in `api/_auth.json` and is never stored.

```
curl -X POST https://<site>/api/bids -H 'Content-Type: application/json' \
  --data @<(jq -n --arg p "$REGISTER_PASSWORD" --slurpfile s pipeline.json '{password:$p,state:$s[0]}')
```

Needs the Vercel Blob store already connected for decision emails. A rebuilt `index.html` is still a valid fallback.


Bid decisions, owners and notes entered on the site are stored in each person's browser and are not written to this repository.

The email check only tests the address format; it does not prove who the visitor is. The password is what protects the data, and it is not stored in this repository.

## Decision emails

`api/decisions.js` is a Vercel function. When someone presses "Save and email decision":

1. If `SMTP_USER` and `SMTP_PASS` are set in the Vercel project, the email is sent at once from that mailbox (Gmail by default; `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM` are optional).
2. If they are not set, or the mail server refuses, the decision goes into an outbox in the connected Vercel Blob store, and a scheduled Claude task sends it within the hour (08:00 to 20:00 UAE).

- Requests must carry the register password. `api/_auth.json` holds a salted hash of it; regenerate that file if the password changes.
- Sign-in and recipient addresses must be in the allowed domains (`citiesforum.org` by default; override with `ALLOWED_DOMAINS`, comma-separated).
- Never commit mail settings to this repository.
