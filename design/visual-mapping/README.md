# Visual mapping layer — design reference, not a build target

A standalone React sketch of every screen across the three panels, used to reason
about information architecture and shared experience patterns in one place.

**This directory is not built, bundled or deployed.** It has no entry point, no
Vite config and no `package.json`; nothing in the repository imports from it.
Treat it the way you would a Figma export: a reference for what a screen is
meant to contain, not the implementation.

The implementations live in:

| Panel | Source |
|---|---|
| Player | `user-panel/src/` |
| Merchant | `merchant-panel/src/` |
| Admin | `admin-panel/src/` |

## Why it moved here (2026-07-27)

It previously lived at `src/frontend/`, which meant the **root** `package.json`
had to carry React, React Router, three.js, `@react-three/*`, framer-motion and
lucide-react as production dependencies purely to satisfy its imports. The root
package is what the backend Docker image installs (`node backend/server.js`), so
the deployed API server was shipping an entire React and 3D rendering stack it
never loads — and inheriting every advisory filed against it, which is what kept
`npm audit --audit-level=high` red in CI.

Moving the sketch out of the dependency closure removed ten packages from the
backend image and took the root audit to zero findings, with no change to
anything that actually builds: each panel declares its own React stack in its
own `package.json` and lockfile (GOVERNANCE §14).

If this sketch is ever revived as a running app, give it its own
`package.json` + `vite.config.ts` here rather than reintroducing frontend
dependencies to the repository root.
