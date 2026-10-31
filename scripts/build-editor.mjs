import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  absWorkingDir: root, entryPoints: ['web/code-editor.js'],
  outfile: 'web/vendor/code-editor.js', bundle: true, minify: true,
  format: 'iife', legalComments: 'eof', metafile: true,
});
const packages = new Set(Object.keys(result.metafile.inputs).filter(name => name.startsWith('node_modules/')).map(name => {
  const parts = name.split('/');
  return parts[1].startsWith('@') ? parts.slice(1, 3).join('/') : parts[1];
}));
const licenses = [];
for (const name of [...packages].sort()) {
  const directory = path.join(root, 'node_modules', name);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const filename = (await fs.readdir(directory)).find(file => /^license(?:\.(?:txt|md))?$/i.test(file));
  if (!filename) throw new Error(`Missing license for ${name}`);
  licenses.push(`${name} ${manifest.version}\n${await fs.readFile(path.join(directory, filename), 'utf8')}`);
}
await fs.writeFile(path.join(root, 'web/vendor/LICENSES.txt'), licenses.join('\n\n---\n\n'));
console.log(`Built offline editor and preserved licenses for ${packages.size} dependencies.`);
