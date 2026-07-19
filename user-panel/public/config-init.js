// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Read config from meta tags — keeps CSP scriptSrc at 'self' with no unsafe-inline.
(function () {
  var api  = document.querySelector('meta[name="x-bazaar-api-url"]');
  var sock = document.querySelector('meta[name="x-bazaar-socket-url"]');
  window.BAZAAR_CONFIG = {
    API_URL:    api  ? api.content  : '/api',
    SOCKET_URL: sock ? sock.content : '/'
  };
})();
