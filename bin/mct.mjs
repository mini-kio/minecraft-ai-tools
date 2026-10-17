#!/usr/bin/env node
import fs from 'node:fs';
if (Number(process.versions.node.split('.')[0]) < 24) { console.error('MCT requires Node.js 24 or newer.'); process.exit(1); }
const target = new URL('../dist/cli.js', import.meta.url);
if (!fs.existsSync(target)) { console.error('MCT needs a build. Run pnpm install && pnpm build in the project folder.'); process.exit(1); }
await import(target.href);
