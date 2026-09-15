// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { getBackend } from './backend.service';

// Re-export the singleton instance to ensure consistency across the app.
export const backend = getBackend();