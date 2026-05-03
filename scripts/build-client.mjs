import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'dist', 'public');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await copyFile(path.join(root, 'public', 'index.html'), path.join(outDir, 'index.html'));
await copyFile(path.join(root, 'public', 'style.css'), path.join(outDir, 'style.css'));

await build({
  entryPoints: [path.join(root, 'public', 'app.ts')],
  outfile: path.join(outDir, 'app.js'),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
});

console.log('client built to dist/public');
