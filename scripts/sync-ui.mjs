import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(process.env.RESIDENT_SOURCE || resolve(root, '../Aelios-resident-dsh-native'));
const files = ['index.html', 'app.js', 'app.css', 'desktop.js', 'markdown.js', 'group.js', 'models.json', 'icon-192.png', 'icon-512.png', 'vendor/alpine-3.14.9.min.js', 'vendor/alpine-LICENSE.txt'];
const hashes = {};
for (const file of files) {
  const bytes = await readFile(resolve(source, 'public', file));
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
  const target = resolve(root, 'ui', file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(source, 'public', file), target);
}
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
await writeFile(resolve(root, 'ui/SOURCE.json'), JSON.stringify({ repository: 'https://github.com/wusaki0723/Aelios-resident', revision, hashes }, null, 2) + '\n');
console.log(`Copied ${files.length} original Resident assets; hashes recorded in ui/SOURCE.json. Service Worker and cloud execution scripts are excluded.`);
