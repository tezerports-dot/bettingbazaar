# KYC documents: a public CDN URL is not an access-control model

**Status: BUILT AND WIRED. Every KYC document path now goes to a private
bucket, and no code path can produce a public URL for one. What remains is
creating the bucket and setting four variables — until then the KYC routes
return 503 rather than falling back. See "What is left".**

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
so a record written before the cutover still renders; nothing writes them any
more.

### Deliberately a separate module and client

Not a category inside `cdn.service.js`. That service exists to make objects
**public and fast** — it composes CDN URLs and its callers assume that. Sharing
it would mean one misrouted category silently republishing identity documents,
which is the failure this module exists to prevent. Different safety property,
different client.

---

## The wiring (2026-08-11)

The module above was built and tested some time ago and **nothing called it**.
A tested module that is not wired in protects nothing: the upload route still
went to `cdn.service`, the submit route stored the resulting public URL in
`kycData.idProofUrl`, and the admin queue shipped that URL to every reviewer's
browser for every user in the queue. That is what this change closes.

### Upload — `routes/upload.routes.js`

`POST /api/upload/user/kyc/:docType/upload-url` mints a presigned PUT against
the private bucket. The response carries `key` and **no `cdnUrl`** — there is no
public address for an Aadhaar card to hand back, and the client must not receive
something shaped like one.

**It fails closed.** Every other upload category degrades to 503 when storage is
unconfigured, and that is fine — a missing chat attachment is an inconvenience.
Here, "fall back to the old path" means publishing a government ID, so an
unconfigured private store refuses the upload instead. KYC submission is a
separate flow from registration and sign-in, so this blocks verification alone.

### Submission — `domains/user/user.routes.js`

`POST /api/user/:userId/kyc` verifies both keys through
`kycDocuments.verifyUploaded` and writes `kycData.idProofKey` /
`kycData.photoKey`. No URL is written.

The key is the only thing the client supplies, so the route checks that it
**belongs to the submitting user and is the document type claimed**. The old CDN
path checked `expectedUserId`; losing that while moving to a private bucket
would have traded one exposure for a worse one — user A submitting user B's key,
and a reviewer approving B's Aadhaar card as A's identity. `parseKey` reads the
owner and type back out of the key, and `presignReview` re-checks the owner
against the record the key came from.

`user.routes.js` no longer imports `cdn.service.js` at all. A module that cannot
reach the public CDN cannot publish an identity document by any future edit, and
there is a test asserting the import stays gone.

### Review — `routes/admin/kyc.admin.routes.js`

`GET /api/admin/kyc/:userId/document/:docType`, behind `canVerifyKYC`, mints a
120-second presigned GET for one document and writes a `KYC_DOCUMENT_VIEWED`
audit row. The audit records the **key**, never the minted URL: an audit log is
the one store designed never to be deleted from, and putting a live credential
in it would undo the expiry.

The queue no longer carries any document reference at all. `idProofKey`,
`photoKey` and the legacy URL fields are `select: false` on the schema — the
same treatment `aadhaarNumber` already had, for the same reason: several admin
routes return whole user documents, and a field that ships by default ends up in
API responses, browser history and support tickets.

### Panels

`KYCQueue.tsx` fetches a grant when a reviewer clicks a document tile and drops
the image when the grant expires, instead of rendering a stored URL into an
`<img>`. `KYCModal.tsx` submits keys only, and its file picker now offers only
the three formats the store accepts — it previously offered `.pdf`, which the
private store refuses, so the user waited through an upload that was always
going to be rejected.

### Mirrors

`mirrorUserKyc` carries both keys, and the document columns are **COALESCEd**:
absent means unchanged. The mirror is called with whole documents from the
adoption sweep and with partial ones from the reconcile repair path, which
selects only `kycStatus` and `kycData.rejectionReason`. A plain `EXCLUDED`
assignment let the second call null out a key the first had stored — a silent
loss discovered weeks later by a reviewer with no document to open, at which
point it is indistinguishable from an upload that never happened.
`rejection_reason` deliberately keeps last-write-wins, because clearing it on
approval is meaningful.

---

## Verification

**Run**, not inspected:

| suite | count |
|---|---|
| `backend/tests/unit/kycDocuments.test.js` — the module's safety logic | 13 |
| `backend/tests/unit/kycPrivateRouting.test.js` — the wiring | 26 |
| `backend/tests/unit/kycFieldSelection.test.js` — the projections | 8 |
| `backend/tests/postgres/kycDocumentKeyMirror.test.js` — real Postgres | 5 |

### The one that escaped to CI

Making the keys `select: false` meant every query wanting them had to say so,
and the natural way to write that —

```js
.select('kycStatus kycData +kycData.idProofKey')
```

— compiles to `{kycStatus: 1, kycData: 1, 'kycData.idProofKey': 1}`, which
**MongoDB 4.4+ refuses**: a projection may not contain both a path and its
prefix. It throws at query time against a real server only. Unit passed, the
Postgres suite passed (it runs no Mongo queries), and CI's integration step was
the first thing to execute it.

A source-text assertion would not have caught it — the string reads correctly.
`domains/user/kycFieldSelection.js` now holds both projections as named
constants, and `kycFieldSelection.test.js` compiles them against the real schema
and asserts no key is a prefix of another. Its first test feeds the exact broken
string through the same check, so a detector that always passed would itself
fail.

Mutations M33–M42, each applied, tested, reverted — **10/10 killed** (42/42 for
the branch):

| Mutation | Killed by |
|---|---|
| upload route goes back to `cdn.service` | *routes KYC at the private store* |
| unconfigured store falls through instead of refusing | *FAILS CLOSED* |
| submission stores a URL again | *writes the KEY into kycData* |
| ownership check removed | *refuses another user's key* |
| `select: false` dropped from `idProofKey` | *does not leave the database by default* |
| review grant minted without the owner check | *mints the grant per view* |
| mirror stops COALESCEing the key | *does NOT lose the keys on a partial repair* |
| `rejection_reason` becomes sticky | *still clears a rejection reason on approval* |
| the sweep asks for a parent AND its child | *names no parent alongside its child* |
| the sweep stops asking for the keys | *brings the document keys, which are select:false* |

Several of the wiring assertions read source text rather than making HTTP calls.
That is deliberate: the properties are negative ("this file cannot reach the
public CDN"), the alternative needs Mongo and so runs only in CI, and a source
assertion fails exactly when someone adds a fourth call site the old way — which
is the regression worth catching.

**NOT VERIFIED:** none of this has run against a real R2 bucket. The S3 client is
mocked; what is proven is the application's own logic, not that R2 accepts these
calls. No credentials exist in this environment.

---

## What is left

Deployment, not code:

1. **Create the private R2 bucket.** Public access **disabled**, no custom
   domain, no CDN binding. Everything above depends on this and **none of it is
   enforceable from application code** — it is a property of how the bucket is
   created. It must be a different bucket from `S3_BUCKET_NAME`.
2. **Set `KYC_S3_ENDPOINT`, `KYC_S3_BUCKET`, `KYC_S3_ACCESS_KEY`,
   `KYC_S3_SECRET_KEY`** (and `KYC_S3_REGION=auto` for R2). They are in
   `.env.example` and `deploy/vps/.env.template` with this rationale attached.
   Scope the API token to the private bucket only. **Until all four are set, KYC
   upload and submission return 503** — verification is unavailable, and no
   document is published.
3. **Verify against the real bucket once, before opening signups:** submit a KYC
   document, confirm the object lands in the private bucket, confirm the admin
   review link renders it, and confirm the same URL 404s or 403s after two
   minutes. That last check is the one that proves the expiry is real rather
   than configured.

### The migration steps that no longer apply

Earlier revisions of this document listed "copy existing objects into the
private bucket" and "delete the originals from the public bucket" as steps 4 and
5, and called step 5 the one that actually fixes the exposure.

**Neither applies: the platform has not launched.** There is no production
deployment and no staging, so no user has ever submitted a KYC document and
there is nothing in the shared bucket to migrate or delete. The exposure
described at the top of this document was real as a property of the code and is
now closed before any document ever passed through it.

One caveat, and it is the only one: **if any KYC document was uploaded during
development or manual testing against a real shared bucket, delete it from that
bucket.** The application no longer writes there, but the object and its
permanent URL would survive this change untouched. Nothing in the codebase can
tell you whether such an object exists — check the bucket.
