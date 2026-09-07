import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'lib');
await mkdir(outDir, { recursive: true });

for (const name of [
  'journal-client.mjs',
  'journal-supabase-transport.mjs',
  'journal-media-client.mjs',
  'journal-media-supabase-transport.mjs'
]) {
  await copyFile(path.join(root, 'shared', name), path.join(outDir, name));
}

console.log('Prepared Journal client and media modules for static publish.');
