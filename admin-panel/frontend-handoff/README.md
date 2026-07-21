# Admin Panel Frontend Handoff

Internal operations/admin experience for users, finance, KYC, content, settings, disputes, and reporting.

# Frontend Handoff

This folder is a generated frontend-only handoff for UI/UX design review.

It intentionally contains panel UI source, public assets, and build/config files, but it does not include the repository backend, databases, infrastructure, node_modules, build output, or root-level secrets.

## How to use

1. Copy this folder outside the main repository if you want to share it with a designer.
2. Run `npm install` from inside this folder if dependencies are needed.
3. Run `npm run dev` to preview the panel locally.
4. Treat API/service files as integration references only; designers should normally work with mock data.

## Refreshing this handoff

From the repository root, run:

```bash
node scripts/create-frontend-handoffs.mjs
```
