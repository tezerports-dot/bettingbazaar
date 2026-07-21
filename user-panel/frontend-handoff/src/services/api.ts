// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { getBackend } from './backend.service';

// Re-export the singleton instance to ensure consistency across the app.
export const backend = getBackend();