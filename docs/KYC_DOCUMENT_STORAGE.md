# KYC documents: a public CDN URL is not an access-control model

**Status: the private store is BUILT and tested. The migration is a deployment
sequence, and it has NOT been run — see "What has not happened yet".**

Task H(b) asked for KYC documents to move to Cloudflare R2, on the principle
that neither database should hold blobs. Neither database ever did. The finding
below is what was actually wrong.

---

## What was actually wrong

Blobs were never in Mongo or Postgres. `services/cdn.service.js` has always put
the bytes in S3 and stored a string. The problem is which storage, and which
string.

KYC documents — Aadhaar cards, PAN cards, selfies — went into the **same bucket
as branding images and payment screenshots**, and `kycData.idProofUrl` held a
**public BunnyCDN URL**:

```js
const cdnUrl = `${CDN_URL}/${fileKey}`;   // cdn.service.js
```

The key carries 128 bits of randomness (`crypto.randomBytes(16)`), so it is not
guessable. That is the entire protection.

An unguessable URL is a capability, and this is a poor one:

| property | consequence |
|---|---|
| never expires | one disclosure is permanent |
| stored in Mongo, mirrored to Postgres | in every database backup, in two stores |
| returned by admin APIs, rendered in the panel | browser history, screenshots, support tickets |
| needs no authentication | anyone holding the string is authorised, forever |

A CDN zone exists to serve objects to anyone who asks. Putting government
identity documents behind one and relying on nobody learning the path is not an
access-control model — and the path is written into two databases, which is
where the model breaks down entirely.

## What replaces it

`services/kycDocuments.service.js`: a **separate, private bucket** on Cloudflare
R2 (S3-compatible, so the `@aws-sdk/client-s3` already in the tree drives it),
with no CDN in front and no public URL anywhere.

| | before | now |
|---|---|---|
| bucket | shared with public assets | dedicated, private |
| stored in the databases | a public URL (a grant) | an object **key** (a reference) |
| read access | permanent, unauthenticated | presigned GET, **120s**, minted per review |
| upload | presigned PUT | presigned PUT, content type and length pinned |
| ACL | inherited from a public bucket | never set — asserted by a test |

The point is the third row. Access to an identity document becomes a decision
taken at review time by an authenticated admin — auditable and revocable —
instead of a property of a string written into two databases years earlier.

`user_kyc` gained `id_proof_key` and `photo_key` for this. The URL columns stay
during the migration; the key is the durable identity of the blob and survives a
bucket or CDN change, which the URL does not.

### Deliberately a separate module and client

Not a category inside `cdn.service.js`. That service exists to make objects
**public and fast** — it composes CDN URLs and its callers assume that. Sharing
it would mean one misrouted category silently republishing identity documents,
which is the failure this module exists to prevent. Different safety property,
different client.

## Verification

All **run**, 13 tests in `backend/tests/unit/kycDocuments.test.js`:

- no ACL is ever set on an upload (the one line that could republish a document)
- review grants default to 120s and are **bounded to 600s** however the caller
  asks — a "convenient" hour-long link is the same failure in a smaller form
- images only; PDFs, archives, HTML and `image/svg+xml` are refused
- content type and length are pinned into the upload grant, so a grant for a 2KB
  JPEG cannot be spent on something else
- keys outside `kyc/` are refused for both review and deletion, so the module
  cannot become a general-purpose read oracle for the bucket
- keys are namespaced per user, so an erasure request can enumerate one subject

Mutations, each reverted after:

| Mutation | Test killed |
|---|---|
| `ACL: 'public-read'` on upload | *NEVER sets an ACL* |
| review TTL honoured unbounded instead of clamped | *BOUNDS what a caller may ask for* |

## What has NOT happened yet

**NOT VERIFIED — none of this has run against a real R2 bucket.** The S3 client
is mocked in the tests; what is proven is the module's own safety logic, not
that R2 accepts these calls. No credentials exist in this environment.

The remaining work is a deployment sequence, not code:

1. Create the private R2 bucket. **Public access disabled, no custom domain, no
   CDN binding.** Everything above depends on this and none of it is enforced
   from application code.
2. Set `KYC_S3_BUCKET`, `KYC_S3_ENDPOINT`, `KYC_S3_ACCESS_KEY`,
   `KYC_S3_SECRET_KEY`. Until all four are set, `configured()` is false and the
   existing path is used unchanged — a KYC submission that started failing on a
   missing environment variable would take registration down, so this falls back
   rather than failing closed.
3. Route `user.routes.js`'s KYC submission at the new service, and add an
   admin review endpoint that mints a presigned GET per request. **Not done in
   this change** — it needs the panel to fetch a URL at view time instead of
   reading one from the record, which is a frontend change in three repos.
4. Copy existing objects into the private bucket, populate `id_proof_key` /
   `photo_key`, and only then stop writing the URL columns.
5. **Delete the originals from the public bucket.** Until this step the old URLs
   still work, so the exposure above is unchanged no matter what the new code
   does. This is the step that actually fixes it.

Step 5 is the one that matters, and steps 3–5 are not in this change.

## The live exposure, stated plainly

Every KYC document uploaded so far is reachable at a permanent, unauthenticated
URL by anyone who has ever seen that URL — including anyone with a copy of a
database backup, since the URL is a column in both stores. That is true today
and stays true until step 5 runs. It is not a regression introduced here; it is
the state this document exists to get changed.
