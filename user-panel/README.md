# User panel

The user panel is an independent Vite application within the monorepo. Its
source lives in `src/`, static PWA files in `public/`, and build output in
`dist/`.

From the repository root:

```bash
npm --prefix user-panel ci --legacy-peer-deps
npm run dev
npm run build:user
```

The panel has its own package manifest, lockfile, and Vite configuration. It
must not import source files from `admin-panel/`, `merchant-panel/`, or
`backend/`.
