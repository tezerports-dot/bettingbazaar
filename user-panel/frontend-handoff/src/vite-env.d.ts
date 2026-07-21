// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/// <reference types="vite/client" />

// Type declarations for Vite environment variables used in the user panel.
// These are baked in at build time by Vite. Set them in Railway → user-panel service → Variables.
interface ImportMetaEnv {
  readonly VITE_API_URL: string;   // Backend URL, e.g. https://betting-bazaar-backend.up.railway.app
  readonly VITE_WS_URL?: string;   
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
