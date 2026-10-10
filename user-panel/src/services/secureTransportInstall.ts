// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Side-effect module: the FIRST import of index.tsx. ES modules evaluate in
 * import order, so this runs before App and every service it pulls in — and
 * therefore before any of them can open a request on the system resolver.
 * In the Android shell it routes fetch and EventSource through the native
 * DNS-over-HTTPS client (./secureTransport); on the web it does nothing.
 */
import { installSecureTransport } from './secureTransport';

installSecureTransport();
