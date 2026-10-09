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

Needs a Vercel Blob store connected to the project. A rebuilt `index.html` is still a valid fallback.


## Shared decisions

`api/decisions.js` keeps each bid's decision, owner, next action, target date and notes in the Blob store (`data/decisions.json`), so everyone who signs in sees the same ones.

- `GET /api/decisions` (header `X-Register-Key: <password>`) returns all decisions. `POST /api/decisions` with `{password, user, items: {id: decision}}` saves them; the newest save per bid wins, and the save is retried if two people save at once.
- The page loads decisions when it opens, then every 45 seconds and whenever the tab is focused again. The copy in the browser is only a cache. If the server cannot be reached, the decision is kept on that device and sent again automatically.
- ## Bid checklists

`api/checklist.js` lets anyone signed in upload one Excel checklist per bid ("Upload bid checklist" in the bid's decision box) and download it. Uploading again replaces the file.

- Only Excel workbooks are accepted: `.xlsx` or `.xls`, up to 4 MB (Vercel's request limit). The server checks the file name and the file contents, so a renamed file of another type is refused. Macro files (`.xlsm`) are not accepted.
- Files are kept in the Blob store under `checklists/`, with the list of uploads in `data/checklists.json`. Reading, uploading and downloading all need the register password; an `@citiesforum.org` address is needed to upload.
- If the Blob store was created as public, the file addresses are public but unguessable (random suffix) and are never shown on the page; a private store is better.

Bids with a checklist show a paperclip in the list. "View checklist" opens the workbook in a preview window (each sheet as a table, read in the browser with no outside library; `.xlsx` only, so `.xls` files are download-only), and "Download" saves the file.

The site does not send any email.


The email check only tests the address format; it does not prove who the visitor is. The password is what protects the data, and it is not stored in this repository.
