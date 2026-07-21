import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const panels = [
  {
    dir: 'user-panel',
    name: 'User Panel',
    description: 'Customer-facing betting, wallet, promotions, history, profile, and support experience.',
  },
  {
    dir: 'admin-panel',
    name: 'Admin Panel',
    description: 'Internal operations/admin experience for users, finance, KYC, content, settings, disputes, and reporting.',
  },
  {
    dir: 'merchant-panel',
    name: 'Merchant Panel',
    description: 'Merchant dashboard experience for orders, payouts, history, profile, and operational views.',
  },
];

const filesToCopy = [
  'src',
  'public',
  'index.html',
  'inject-build-id.cjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'tailwind.config.js',
  'postcss.config.js',
  'eslint.config.js',
];

const generatedNotice = `# Frontend Handoff\n\nThis folder is a generated frontend-only handoff for UI/UX design review.\n\nIt intentionally contains panel UI source, public assets, and build/config files, but it does not include the repository backend, databases, infrastructure, node_modules, build output, or root-level secrets.\n\n## How to use\n\n1. Copy this folder outside the main repository if you want to share it with a designer.\n2. Run \`npm install\` from inside this folder if dependencies are needed.\n3. Run \`npm run dev\` to preview the panel locally.\n4. Treat API/service files as integration references only; designers should normally work with mock data.\n\n## Refreshing this handoff\n\nFrom the repository root, run:\n\n\`\`\`bash\nnode scripts/create-frontend-handoffs.mjs\n\`\`\`\n`;

for (const panel of panels) {
  const panelRoot = path.join(root, panel.dir);
  const handoffRoot = path.join(panelRoot, 'frontend-handoff');

  rmSync(handoffRoot, { recursive: true, force: true });
  mkdirSync(handoffRoot, { recursive: true });

  for (const item of filesToCopy) {
    const source = path.join(panelRoot, item);
    if (!existsSync(source)) continue;
    const destination = path.join(handoffRoot, item);
    cpSync(source, destination, {
      recursive: true,
      filter: (sourcePath) => {
        const relative = path.relative(panelRoot, sourcePath).replaceAll(path.sep, '/');
        return !(
          relative.includes('/node_modules/') ||
          relative.includes('/dist/') ||
          relative.includes('/frontend-handoff/') ||
          relative.endsWith('.env') ||
          relative.includes('/.env')
        );
      },
    });
  }

  writeFileSync(
    path.join(handoffRoot, 'README.md'),
    `# ${panel.name} Frontend Handoff\n\n${panel.description}\n\n${generatedNotice}`,
  );
}

console.log('Frontend handoff folders generated:');
for (const panel of panels) {
  console.log(`- ${panel.dir}/frontend-handoff`);
}
