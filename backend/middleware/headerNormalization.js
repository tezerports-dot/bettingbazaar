// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** Drop request-smuggling primitives before body parsing or proxy-derived trust. */
export function rejectAmbiguousFraming(req, res, next) {
  const names = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) names.push(String(req.rawHeaders[i]).toLowerCase());
  const contentLengthCount = names.filter((h) => h === 'content-length').length;
  const hasTransferEncoding = names.includes('transfer-encoding');
  if ((contentLengthCount > 0 && hasTransferEncoding) || contentLengthCount > 1) {
    return res.status(400).json({ success: false, message: 'Ambiguous HTTP framing rejected' });
  }
  next();
}
