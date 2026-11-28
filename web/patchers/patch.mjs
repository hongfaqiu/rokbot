#!/usr/bin/env node
// Build the web client bundle that a Host serves at /web/. The interface comes from the
// user's own copy of the official Grok Bot Windows installer (verified against pinned hashes)
// with the RokBot desktop recipes and the web interface patches applied; the bridge and
// browser layer live in web/client. The bundle is installed on the user's own Host (admin
// page, or --upload) and is never published.
import { readFile, writeFile, mkdir, mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { applyReleaseRecipes } from '../../mac/patchers/desktop/release-recipes.mjs';
import { acquireDesktopSource } from '../../mac/patchers/desktop/download-original.mjs';
import { unpackOriginal } from '../../windows/patchers/desktop/original.mjs';
import { selectWindowsRelease } from '../../windows/patchers/desktop/inputs.mjs';
import { appVersionArg, resolveAppVersion } from '../../mac/patchers/desktop/app-version.mjs';
import { withInstallerDiagnostic } from '../../windows/patchers/desktop/input-diagnostic.mjs';
import { desktopEdges } from '../../mac/clients/desktop/local-services.mjs';
import { rendererPatches, applyPinnedRendererPatch } from './renderer-patches.mjs';
import { writeZip, createEntry } from './zip.mjs';
import { writeBuildOutput } from './output.mjs';
import { uploadBundle, adminPassword } from './upload.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const repo = path.resolve(webRoot, '..');
const sharedAssets = ['i18n.mjs', 'avatar-image.mjs', 'external-url.mjs', 'connectors.mjs', 'dictation.mjs', 'sand-machines.mjs', 'model-bridge.mjs', 'zip-store.mjs', 'workspace.css', 'workspace-keys.cjs', 'composer-assist.cjs', 'group-create.cjs', 'settings-nav.cjs', 'bot-profile.cjs'];
export const BUNDLE_SCHEMA = 'rokbot-web-bundle/v1';
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(filename) { return sha(await readFile(filename)); }

export function resolveWebIcons(rootDir = repo) {
  return {
    icon256Path: path.join(rootDir, 'assets/logo/rokbot-icon-256.png'),
    icon512Path: path.join(rootDir, 'assets/logo/rokbot-icon-512.png'),
  };
}

function assertPngDimensions(bytes, expectedSize, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC) ||
      bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`Invalid RokBot PNG icon: ${label}`);
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`Unexpected RokBot icon dimensions for ${label}: ${width}x${height} (expected ${expectedSize}x${expectedSize})`);
  }
}

export async function readWebIcons(rootDir = repo) {
  const { icon256Path, icon512Path } = resolveWebIcons(rootDir);
  const [icon, icon512] = await Promise.all([readFile(icon256Path), readFile(icon512Path)]);
  assertPngDimensions(icon, 256, icon256Path);
  assertPngDimensions(icon512, 512, icon512Path);
  return { icon, icon512 };
}

export const WEB_TAGS = '<script src="../client/boot-data.js"></script>\n    <script src="../client/compat.js"></script>\n    ' +
  '<script src="../client/desktop/workspace-keys.js"></script>\n    <script type="module" src="../client/bridge.js"></script>\n    ' +
  '<script type="module" src="../client/web-shell.js"></script>\n    <link rel="stylesheet" href="../client/android.css">\n    ' +
  '<link rel="stylesheet" href="../client/desktop/workspace.css">\n    <link rel="stylesheet" href="../client/web.css">\n    ' +
  '<link rel="icon" type="image/png" sizes="256x256" href="../client/icon.png">\n    ' +
  '<link rel="icon" type="image/png" sizes="512x512" href="../client/icon-512.png">\n    ' +
  '<link rel="apple-touch-icon" href="../client/icon-512.png">\n    ' +
  '<link rel="manifest" href="/web/manifest.webmanifest" crossorigin="use-credentials">\n    ' +
  '<meta name="mobile-web-app-capable" content="yes">\n    <meta name="apple-mobile-web-app-capable" content="yes">\n    ' +
  '<meta name="apple-mobile-web-app-title" content="RokBot">\n    ';
const MODULE_ANCHOR = '<script type="module" crossorigin src="./assets/index-';
const FRAME_ANCHOR = /frame-src sand-html-preview: sand-canvas: sand-mcp-app:(?: sand-[a-z-]+:)*;/g;
const CONNECT_ANCHOR = /connect-src 'self' ws: /g;

/**
 * Inserts the bridge ahead of the renderer. The Bot computer view loads from the Host itself
 * (`frame-src 'self'`), and a realtime call over HTTPS needs `wss:` beside the original `ws:`.
 */
export function webIndexHtml(html) {
  const at = html.indexOf(MODULE_ANCHOR), frames = [...html.matchAll(FRAME_ANCHOR)], connects = [...html.matchAll(CONNECT_ANCHOR)];
  if (at < 0 || html.indexOf(MODULE_ANCHOR, at + 1) >= 0 || frames.length !== 1 || connects.length !== 1)
    throw new Error('界面入口与支持的版本不一致。');
  return (html.slice(0, at) + WEB_TAGS + html.slice(at))
    .replace(/<title>\s*Grok Bot\s*<\/title>/gi, '<title>RokBot</title>')
    .replace(FRAME_ANCHOR, sources => `${sources.slice(0, -1)} 'self';`)
    .replace(CONNECT_ANCHOR, "connect-src 'self' ws: wss: ");
}

export function preloadMethods(source) {
  return [...desktopEdges(source).main].sort();
}

export function preloadEdges(source) {
  return Object.fromEntries([...desktopEdges(source).others].map(([edge, methods]) => [edge, [...methods].sort()]));
}

export function webRenderers(build) {
  const pins = ({ desktopVersion, rendererIndexSha256, preloadSha256, vncPreloadSha256 }) =>
    ({ desktopVersion, rendererIndexSha256, preloadSha256, vncPreloadSha256 });
  return [pins(build), ...(build.fallback ?? []).map(pins)];
}

export function wrapPreload(source) {
  return `// Generated by web/patchers/patch.mjs from the original preload.cjs of the user's download.\n` +
    `export const methods = ${JSON.stringify(preloadMethods(source))};\n` +
    `export const edges = ${JSON.stringify(preloadEdges(source))};\n` +
    `export default function preload(require, process) {\nconst module = { exports: {} };\n` +
    `(function (module, exports) {\n${source}\n}).call(module.exports, module, module.exports);\n}\n`;
}

// Both originals are CommonJS bundles (`module.exports = ...`); the VNC one installs itself on load.
export function wrapVncPreload(source) {
  return `// Generated by web/patchers/patch.mjs from the original preload-vnc.cjs of the user's download.\n` +
    `(function (require, process) {\nconst module = { exports: {} };\n` +
    `(function (module, exports) {\n${source}\n}).call(module.exports, module, module.exports);\n` +
    `})(window.__rokbotVncPreload.require, window.__rokbotVncPreload.process);\n`;
}

// extractAll buffers the entire ASAR. Stage individual reviewed members instead; include existing
// recipe destinations so the shared replayer still detects collisions with a declared new file.
export async function stageWebArchive(asar, archive, unpacked, recipes, verifyOnly, patches) {
  const manifest = JSON.parse(await readFile(path.join(recipes, 'manifest.json'), 'utf8'));
  const members = new Set(asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, '')));
  const needed = new Set(['dist/renderer/index.html', 'dist/electron-preload/preload.cjs', 'dist/electron-preload/preload-vnc.cjs',
    ...patches.map(patch => `dist/renderer/${patch.file}`)]);
  for (const file of manifest.files) {
    needed.add(file.path);
    if (file.source !== null) needed.add(file.source ?? file.path);
  }
  if (!verifyOnly) for (const name of members) if (name.startsWith('dist/renderer/')) needed.add(name);
  for (const name of needed) {
    if (typeof name !== 'string' || name.includes('\\') || path.win32.parse(name).root || name.split('/').some(p => !p || p === '.' || p === '..'))
      throw new Error(`Invalid ASAR member path: ${name}`);
    if (!members.has(name)) continue;
    const member = path.normalize(name), target = path.join(unpacked, member), info = asar.statFile(archive, member, false);
    if ('link' in info) throw new Error(`Unexpected link in Web inputs: ${name}`);
    if ('files' in info) { await mkdir(target, { recursive: true }); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, asar.extractFile(archive, member, false));
  }
  await applyReleaseRecipes(unpacked, recipes);
  return manifest.files.length;
}

export async function verifyStagedRenderer(dist, build, patches = rendererPatches(build.desktopVersion), indexHtml = webIndexHtml) {
  const pinned = async (name, digest) => {
    const bytes = await readFile(path.join(dist, name));
    if (sha(bytes) !== digest) throw new Error(`${name} 与支持的版本不一致。`);
    return bytes.toString('utf8');
  };
  const index = 'renderer/index.html';
  const patchedHtml = indexHtml(await pinned(index, build.rendererIndexSha256));
  await writeFile(path.join(dist, index), patchedHtml);
  const preload = await pinned('electron-preload/preload.cjs', build.preloadSha256);
  const vncPreload = await pinned('electron-preload/preload-vnc.cjs', build.vncPreloadSha256);
  for (const patch of patches) {
    const file = path.join(dist, 'renderer', patch.file);
    await writeFile(file, applyPinnedRendererPatch(patch, await readFile(file)));
  }
  for (const file of [
    path.join(webRoot, 'client/bridge.js'),
    path.join(webRoot, 'client/android.css'),
    path.join(webRoot, 'client/web-shell.js'),
    path.join(webRoot, 'client/native.js'),
    path.join(webRoot, 'client/boot-data.js'),
    ...sharedAssets.map(name => path.join(repo, 'mac/clients/desktop', name)),
  ]) {
    if (!(await stat(file)).isFile()) throw new Error(`Missing Web bridge input: ${path.basename(file)}`);
  }
  await readWebIcons(repo);
  return { preload, vncPreload };
}

async function listFiles(root, prefix = '') {
  const result = [];
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) result.push(...await listFiles(root, relative));
    else if (item.isFile()) result.push(relative);
  }
  return result.sort();
}

/** The files of the bundle, by path: the patched renderer, the bridge and the copied originals. */
export async function bundleFiles({ dist, preload, vncPreload, icon, icon512, build }) {
  const files = new Map();
  const add = (name, bytes) => { if (files.has(name)) throw new Error(`重复的文件：${name}`); files.set(name, Buffer.from(bytes)); };
  for (const name of await listFiles(path.join(dist, 'renderer'))) {
    const bytes = /^assets\/app-icon-[^/]+\.png$/.test(name) ? icon : await readFile(path.join(dist, 'renderer', name));
    add(`renderer/${name}`, bytes);
  }
  for (const name of await listFiles(path.join(webRoot, 'client'))) add(`client/${name}`, await readFile(path.join(webRoot, 'client', name)));
  for (const name of sharedAssets)
    add(`client/desktop/${name.replace(/\.cjs$/, '.js')}`, await readFile(path.join(repo, 'mac/clients/desktop', name)));
  add('client/official-preload.js', wrapPreload(preload));
  add('client/vnc-preload.js', wrapVncPreload(vncPreload));
  add('client/icon.png', icon);
  if (icon512 !== undefined && icon512 !== null) add('client/icon-512.png', icon512);
  add('client/build.json', JSON.stringify(build));
  return files;
}

/** A ZIP whose first entry, web-bundle.json, lists every other file with its size and SHA-256. */
export function bundleZip(files, build) {
  const manifest = { schema: BUNDLE_SCHEMA, ...build,
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])) };
  const entries = [createEntry('web-bundle.json', JSON.stringify(manifest, null, 2))];
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) entries.push(createEntry(name, bytes));
  return { zip: writeZip(entries), manifest };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  const build = JSON.parse(await readFile(path.join(here, 'supported.json'), 'utf8'));
  const renderers = webRenderers(build), accepted = renderers.map(renderer => renderer.desktopVersion);
  if (args.includes('--help')) {
    const [recommended, ...older] = accepted;
    console.log(`node web/patchers/patch.mjs [--source <Grok_Bot_${recommended}_Setup.exe | app-64.7z | 安装目录>] [--version <${accepted.join('|')}>]
    [--output <目录>] [--app-version <x.y.z>] [--force] [--verify-only] [--upload <Host 地址>] [--password-file <文件>]
生成网页版界面包；界面推荐取自 Windows ${recommended}${older.length ? `，${recommended} 用不了时再用 ${older.join('、')}` : ''}。
--source 指定的官方 Windows 原版按摘要自动识别版本；省略 --source 时自动下载并校验 ${recommended}（或 --version 指定的版本）Windows x64 安装包。
--verify-only 在临时目录验证原包、Windows recipe、网页入口和界面补丁，不生成文件。
--upload 生成后用管理员密码登录 Host，把界面包安装到 Host 上；密码取自 ROKBOT_ADMIN_PASSWORD、--password-file，或在终端输入。
--app-version 设置网页版对外版本号（界面包清单与文件名），不低于官方界面版本；默认与官方版本相同。
默认输出到 web/output/RokBotLocal-web-<版本>.zip，也可以在管理页「网页版」里上传。`);
    return;
  }
  const verifyOnly = args.includes('--verify-only');
  const uploadTo = arg('--upload');
  const requestedAppVersion = appVersionArg(args);
  // Ask for the password before the long build, so an unattended upload does not wait at the end.
  const password = uploadTo && !verifyOnly ? await adminPassword(arg('--password-file')) : null;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rokbot-web-patch-'));
  try {
    const explicitSource = arg('--source');
    const { directory: windowsDesktop, supported } = await selectWindowsRelease({ source: explicitSource, version: arg('--version'), accepted });
    const renderer = renderers.find(item => item.desktopVersion === supported.version);
    const appVersion = resolveAppVersion(requestedAppVersion, renderer.desktopVersion);
    const source = await acquireDesktopSource({ source: explicitSource, cacheDirectory: verifyOnly ? path.join(temporary, 'download') : path.join(webRoot, '.cache'), supported,
      onDownload: ({ version }) => console.error(`正在下载 Grok Bot ${version} Windows x64 安装包（网页版使用其中的界面）…`) });
    const app = await withInstallerDiagnostic(unpackOriginal(source, temporary, supported), explicitSource && source, supported, accepted);
    const originalExe = path.join(app, 'Grok Bot.exe'), originalAsar = path.join(app, 'resources/app.asar');
    const asarSha256 = await hashFile(originalAsar);
    if (await hashFile(originalExe) !== supported.exeSha256 || asarSha256 !== supported.asarSha256)
      throw new Error(`不支持此发行包。仅支持未经修改的 Grok Bot ${supported.version} Windows ${supported.architecture}；程序或 ASAR 摘要不匹配。`);
    let asar;
    try { asar = createRequire(path.join(repo, 'mac/patchers/desktop/package.json'))('@electron/asar'); }
    catch { throw new Error('缺少 @electron/asar；执行 npm install --prefix mac/patchers/desktop。'); }
    const unpacked = path.join(temporary, 'app');
    const patches = rendererPatches(renderer.desktopVersion);
    const windowsRecipes = await stageWebArchive(asar, originalAsar, unpacked, path.join(windowsDesktop, 'recipes'), verifyOnly, patches);
    const dist = path.join(unpacked, 'dist');
    const { preload, vncPreload } = await verifyStagedRenderer(dist, renderer, patches, webIndexHtml);
    const recommended = renderer.desktopVersion === accepted[0];
    const checks = { windowsRecipes, rendererPatches: patches.length };
    if (verifyOnly) {
      console.log(JSON.stringify({ verified: true, rendererVersion: appVersion, upstreamRendererVersion: renderer.desktopVersion, recommended, asarSha256, checks }));
      return;
    }
    const outputRoot = path.resolve(arg('--output') ?? path.join(webRoot, 'output'));
    const zipPath = path.join(outputRoot, `RokBotLocal-web-${appVersion}.zip`);
    const force = args.includes('--force');
    const within = (root, file) => { const relative = path.relative(root, file); return !relative.startsWith('..') && !path.isAbsolute(relative); };
    if (within(path.resolve(source), zipPath)) throw new Error(`输出位置与输入重叠：${zipPath}`);
    const info = { rendererVersion: appVersion, upstreamRendererVersion: renderer.desktopVersion, recommended, sourceAsarSha256: asarSha256, builtAt: new Date().toISOString() };
    const { icon, icon512 } = await readWebIcons(repo);
    const files = await bundleFiles({ dist, preload, vncPreload, icon, icon512, build: info });
    const { zip, manifest } = bundleZip(files, info);
    await writeBuildOutput(outputRoot, [{ target: zipPath, bytes: zip }], force);
    console.log(JSON.stringify({ output: zipPath, ...info, files: Object.keys(manifest.files).length, bytes: zip.length, sha256: sha(zip), checks }, null, 2));
    if (uploadTo) {
      const result = await uploadBundle(uploadTo, zip, password);
      console.log(JSON.stringify({ uploaded: true, host: new URL(uploadTo).origin, webClient: result }, null, 2));
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
