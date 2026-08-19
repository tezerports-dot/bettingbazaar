// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/// <reference types="vite/client" />

// Type declarations for Vite environment variables used in the user panel.
// Baked in at build time by Vite. Only needed for a SPLIT-ORIGIN or native build;
// the default single-origin launch resolves the API from the page origin.
interface ImportMetaEnv {
  readonly VITE_API_URL: string;   // Backend URL, e.g. https://your-domain.example
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
