#!/usr/bin/env node
// Maintainer tool: regenerate the local-exec daemon recipe of the retained 1.2.3 and 0.71.2
// desktop recipe sets from spec.mjs (localExecDaemonEntry) and the original daemon. The other
// retained recipes are left untouched; the manifest entry for the daemon is updated in place.
//
//   node windows/tools/desktop-recipes/build-retained-local-exec.mjs --version 1.2.3|0.71.2 --source <main.cjs> [--check]
//
// --source is the original dist/local-exec-daemon/main.cjs of that version (macOS and Windows
// 1.2.3 ship the same file). It must match the source pinned in the committed recipe.
// --check rebuilds in memory and fails unless the committed recipe and manifest are identical.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildRecipe, deterministicGzip } from './build.mjs';
import { localExecDaemonEntry } from './spec.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DAEMON = 'dist/local-exec-daemon/main.cjs';
export const RETAINED = Object.freeze({
  '1.2.3': ['mac/patchers/desktop/1.2.3/recipes', 'windows/patchers/desktop/1.2.3/recipes'],
  '0.71.2': ['windows/patchers/desktop/0.71.2/recipes'],
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function buildRetained(version, source, { check = false } = {}) {
  const dirs = RETAINED[version];
  if (!dirs) throw new Error(`Not a retained version: ${version}`);
  const { recipe, target, added } = buildRecipe(localExecDaemonEntry(version), source);
  const compressed = deterministicGzip(JSON.stringify(recipe));
  const stale = [];
  for (const relDir of dirs) {
    const dir = path.join(repo, relDir);
    const manifestFile = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    const entry = manifest.files.find(item => item.path === DAEMON);
    if (!entry) throw new Error(`${relDir} has no ${DAEMON} recipe`);
    const committed = JSON.parse(gunzipSync(await readFile(path.join(dir, entry.recipe))).toString('utf8'));
    if (committed.sourceSha256 !== recipe.sourceSha256) throw new Error(`${relDir}: --source is not the pinned ${version} daemon`);
    const next = { ...entry, sha256: sha(compressed), targetBytes: target.length, addedBytes: added };
    const nextManifest = `${JSON.stringify({ ...manifest, files: manifest.files.map(item => item === entry ? next : item) }, null, 2)}\n`;
    if (check) {
      if (!compressed.equals(await readFile(path.join(dir, entry.recipe))) || nextManifest !== await readFile(manifestFile, 'utf8')) stale.push(relDir);
    } else {
      await writeFile(path.join(dir, entry.recipe), compressed);
      await writeFile(manifestFile, nextManifest);
    }
  }
  if (stale.length) throw new Error(`Committed ${version} local-exec recipes differ from spec.mjs: ${stale.join(', ')}`);
  return { version, dirs, sha256: sha(compressed), targetBytes: target.length, addedBytes: added, checked: check };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  const version = arg('--version'), source = arg('--source');
  if (!version || !source) {
    console.error('node windows/tools/desktop-recipes/build-retained-local-exec.mjs --version 1.2.3|0.71.2 --source <main.cjs> [--check]');
    process.exit(2);
  }
  buildRetained(version, await readFile(source), { check: args.includes('--check') })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exit(1); });
}
