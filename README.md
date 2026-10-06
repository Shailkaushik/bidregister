# Consulting Bid Register

Static bid register for Cities Forum and Katha Media. No build step: the site is `index.html`.

- `index.html`: the register page, with the latest data embedded.
- `pipeline.json`: the same data; the page loads this first when hosted.
- `vercel.json`, `netlify.toml`: ask search engines not to index the site. They are not access control; protect the site on the host.

The daily bid pipeline run rewrites `index.html` and `pipeline.json` and commits them here. Do not edit those two files by hand; changes will be overwritten.

Bid decisions, owners and notes entered on the site are stored in each person's browser and are not written to this repository.
