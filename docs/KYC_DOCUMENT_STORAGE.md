# KYC documents: superseded — there are no KYC documents

**Status: the system this described was REMOVED on 2026-08-25.** There is no
document upload, no private bucket, no presigned review, and no `kycDocuments`
service. KYC is now an Aadhaar **number** captured by the Telegram bot and
verified in bulk — see **`IDENTITY_AND_REFERRALS.md` §6**.

This file is kept because the reasoning below is still load-bearing: several code
comments point here, the finding explains why an unguessable URL is not access
control, and the constraints listed in "If documents ever come back" are the ones
a future implementation would have to satisfy. Nothing here describes code that
exists today.

---

## The original finding (still correct, still worth knowing)

Blobs were never in Mongo or Postgres. `services/cdn.service.js` put the bytes in
S3 and stored a string. The problem was **which** storage, and **which** string.

KYC documents — Aadhaar cards, PAN cards, selfies — went into the **same bucket
as branding images and payment screenshots**, and `kycData.idProofUrl` held a
**public BunnyCDN URL**:

```js
const cdnUrl = `${CDN_URL}/${fileKey}`;   // cdn.service.js
```

The key carried 128 bits of randomness, so it was not guessable. That was the
entire protection.

An unguessable URL is a capability, and this was a poor one:

| property | consequence |
|---|---|
| never expires | one disclosure is permanent |
| stored in Mongo, mirrored to Postgres | in every database backup, in two stores |
| returned by admin APIs, rendered in the panel | browser history, screenshots, support tickets |
| needs no authentication | anyone holding the string is authorised, forever |

A CDN zone exists to serve objects to anyone who asks. Putting government
identity documents behind one and relying on nobody learning the path is not an
access-control model — and the path was written into two databases, which is
where the model broke down entirely.

## What it was replaced with, first (2026-08 to 2026-08-25)

A separate **private** bucket, an object **key** in the database rather than a
URL, a presigned GET valid for 120 seconds minted per review, and an audit row
naming the admin on every view. That was a sound design and it worked.

## Why it was removed anyway

Because the documents stopped existing.

Every control in that design — the separate bucket, the expiring grant, the
per-view audit row, the ACL assertion — was there to protect a stored Aadhaar
card and a stored selfie. The Telegram signup takes the Aadhaar **number**
before the account exists, and verification happens in bulk against the issuing
authority, so there is nothing to photograph, nothing to upload, and nothing to
review by eye.

The strongest version of "protect the identity documents" turned out to be not
collecting them. A private bucket that is never written to is still a bucket
somebody has to configure correctly, keep configured correctly, and remember to
audit; an operator who cannot open an Aadhaar card cannot leak one.

Keeping the code "just for the exception case" was the alternative, and it is the
one this codebase has been paying for elsewhere: a second path nobody exercises
is a path nobody reviews, and it comes back the first time someone wires it in
because it was sitting there.

## If documents ever come back

They should not come back as a resurrection of the old module. The constraints
any new implementation has to satisfy, learned the expensive way:

1. **A dedicated private bucket.** Never the one serving public assets — one
   misrouted category silently republishes an identity document.
2. **Store a key, never a URL.** A key is a reference; a URL is a grant.
3. **`select: false` on the key field.** Several admin routes return whole user
   documents, and a key that ships by default puts the reference back into API
   responses, browser history and support tickets.
4. **Read access is a decision at review time**, taken by an authenticated
   reviewer, minted short-lived, and recorded — not a permanent property of a
   string.
5. **Record the key in the audit log, never the grant.** The audit store is one
   nobody deletes from; a live credential must not land in it.
6. **Fail closed.** Every other upload category may degrade to 503 when storage
   is unconfigured; a missing chat attachment is an inconvenience. Here, "fall
   back to the old path" means publishing an identity document.
7. **Re-check ownership when minting a grant.** If a mirror or a migration ever
   crossed two records, the right answer is to refuse rather than show a reviewer
   the wrong person's ID.
8. **Enumerate projection leaves, never a parent and its child.** MongoDB 4.4+
   rejects a projection containing both a path and its prefix, and it throws at
   query time against a real server only — see
   `domains/user/kycFieldSelection.js`.

---

**Current architecture:** `IDENTITY_AND_REFERRALS.md`.
**Proof the path is gone:** `backend/tests/unit/kycDocumentPathRemoved.test.js`.
