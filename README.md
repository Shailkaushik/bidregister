# Consulting Bid Register

Static bid register for Cities Forum. It also carries opportunities screened for Katha Media. No build step: the site is `index.html`.

- `index.html`: the register page. The data inside it is encrypted; the page asks for a Cities Forum email address and the shared password, then decrypts in the browser.
- There is deliberately no plain data file in this repository. Do not add one: anything here is served publicly by the host.
- `vercel.json`, `netlify.toml`: ask search engines not to index the site. They are not access control; protect the site on the host.

The daily bid pipeline run rewrites `index.html` and commits it here. Do not edit it by hand; changes will be overwritten.

Bid decisions, owners and notes entered on the site are stored in each person's browser and are not written to this repository.

The email check only tests the address format; it does not prove who the visitor is. The password is what protects the data, and it is not stored in this repository.
