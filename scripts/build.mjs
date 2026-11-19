import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist', { recursive: true });
await Promise.all([
  copyFile('public/index.html', 'dist/index.html'),
  copyFile('public/portal.css', 'dist/portal.css'),
  build({ entryPoints: ['public/portal.js'], outfile: 'dist/portal.js', bundle: true, format: 'esm' }),
]);
