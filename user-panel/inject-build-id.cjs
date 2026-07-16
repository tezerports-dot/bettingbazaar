const fs = require('fs');
const buildId = Date.now().toString(36).toUpperCase();
const swPath  = 'dist/service-worker.js';
if (fs.existsSync(swPath)) {
  const sw = fs.readFileSync(swPath, 'utf8');
  fs.writeFileSync(swPath, sw.replace("'__BUILD_ID__'", JSON.stringify(buildId)));
  console.log('[build] Service worker BUILD_ID injected:', buildId);
} else {
  console.warn('[build] dist/service-worker.js not found — skipping BUILD_ID injection');
}
