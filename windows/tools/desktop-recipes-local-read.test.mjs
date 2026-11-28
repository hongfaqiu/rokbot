// T-57: Read, ls and CopyToBox on the user's own computer are not limited to the local-exec
// workspace (profile/local-exec/workspace). A short fixed deny list keeps credential stores out
// of reach, including through symlinks. Files copied onto the computer (CopyFromBox, upload,
// chunked write) still land only inside the workspace, and every action still passes through
// isLocalUseBlocked (the approval / auto-review gate) first.
//
// The official daemon refuses those paths in its path resolver (1.3.0 j4, 1.2.3 f4, 0.71.2 X8)
// with "Path is outside the allowed local-exec root and was refused". The recipes route the
// read-side call sites to rokbotLocalReadPath (extensions/local-exec-transfer.js) and give the
// write-side refusal a message that names the real reason.
//
// The last tests run the real patched daemon when ROKBOT_DESKTOP_TEST_LOCAL_EXEC_DAEMON lists
// one or more original dist/local-exec-daemon/main.cjs files (1.3.0, 1.2.3 or 0.71.2, separated
// by the platform path delimiter, with the app's dist/deps next to them); skipped otherwise.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { buildRecipe } from './desktop-recipes/build.mjs';
import { LOCAL_EXEC_DAEMON, localExecDaemonEntry, specForTarget, targetMeta } from './desktop-recipes/spec.mjs';

const OLD_MESSAGE = 'outside the allowed local-exec root';
const EXTENSION = new URL('./desktop-recipes/extensions/local-exec-transfer.js', import.meta.url);
const DAEMON = 'dist/local-exec-daemon/main.cjs';
const RECIPE_DIRS = {
  '1.3.0': ['windows/patchers/desktop/recipes', 'mac/patchers/desktop/recipes', 'linux/patchers/desktop/x64/recipes', 'linux/patchers/desktop/arm64/recipes'],
  '1.2.3': ['mac/patchers/desktop/1.2.3/recipes', 'windows/patchers/desktop/1.2.3/recipes'],
  '0.71.2': ['windows/patchers/desktop/0.71.2/recipes'],
};
const repoUrl = new URL('../../', import.meta.url);

function loadExtension() {
  const sandbox = { require: createRequire(import.meta.url), process, Buffer, setTimeout, clearTimeout, console };
  vm.runInNewContext(`${readFileSync(EXTENSION, 'utf8')}
this.api = { rokbotLocalReadPath, rokbotLocalWritePath, rokbotLocalWriteRefusal, rokbotSensitiveLocalPath };`, sandbox);
  return sandbox.api;
}

async function committedDaemonRecipe(relDir) {
  const dir = new URL(`${relDir}/`, repoUrl);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8'));
  const entry = manifest.files.find(item => item.path === DAEMON);
  const gz = await readFile(new URL(entry.recipe, dir));
  assert.equal(createHash('sha256').update(gz).digest('hex'), entry.sha256, `${relDir} manifest pins its daemon recipe`);
  return JSON.parse(gunzipSync(gz).toString('utf8'));
}
const addedText = recipe => recipe.ops.filter(op => op[0] === 'add').map(op => Buffer.from(op[1], 'base64').toString('utf8')).join('\n');

// --- spec and committed recipes -------------------------------------------------------------

for (const target of ['windows', 'mac', 'linux-x64', 'linux-arm64']) {
  test(`${target}: the 1.3.0 daemon entry sends Read, ls and download through rokbotLocalReadPath`, () => {
    const entry = specForTarget(target).find(item => item.path === DAEMON);
    assert.deepEqual(entry, localExecDaemonEntry(targetMeta(target).version));
    const replaced = entry.edits.filter(edit => 'replace' in edit);
    const reads = replaced.filter(edit => edit.text.includes('rokbotLocalReadPath('));
    assert.equal(reads.length, 3, 'Read, ls and download');
    for (const edit of reads) assert.ok(edit.replace.includes('await j4({root:'), edit.replace);
    // Upload keeps the workspace-limited resolver; only its refusal text changes.
    const refusals = replaced.filter(edit => edit.replace.includes(OLD_MESSAGE));
    assert.equal(refusals.length, 2);
    for (const edit of refusals) assert.match(edit.text, /^throw new Bx\(rokbotLocalWriteRefusal\(t,e(,!0)?\)\)$/);
  });
}

for (const [version, dirs] of Object.entries(RECIPE_DIRS)) {
  test(`${version}: committed daemon recipes carry the read-side resolver and no root wording`, async () => {
    const names = LOCAL_EXEC_DAEMON[version];
    assert.ok(names, `${version} has a daemon anchor table`);
    for (const relDir of dirs) {
      const added = addedText(await committedDaemonRecipe(relDir));
      // A replacement adds only the bytes it does not share with its anchor.
      const count = (text, word) => text.split(word).length - 1;
      const extension = readFileSync(EXTENSION, 'utf8');
      assert.equal(count(added, 'rokbotLocalReadPath') - count(extension, 'rokbotLocalReadPath'), 3, `${relDir}: three read-side call sites`);
      assert.equal(count(added, 'rokbotLocalWriteRefusal(') - count(extension, 'rokbotLocalWriteRefusal('), 2, `${relDir}: two write-side refusals`);
      assert.ok(added.includes(extension), `${relDir}: carries local-exec-transfer.js verbatim`);
      assert.ok(!added.includes(OLD_MESSAGE), `${relDir}: the recipe adds no root wording`);
    }
  });
}

// --- extension: deny list and resolvers -----------------------------------------------------

const PROFILE = '/Users/x/Library/Application Support/RokBot Local';
const ROOT = `${PROFILE}/local-exec/workspace`;

test('ordinary paths anywhere on the computer resolve for read and copy-out', async () => {
  const { rokbotLocalReadPath } = loadExtension();
  for (const p of ['/Users/x/workspace/a.txt', '/Volumes/X/y.png', '/Volumes/ORICO/photos/2026/IMG_0001.HEIC',
    '/Users/lianqishi/workspace/rokbot/README.md', `${ROOT}/inside.txt`]) {
    assert.equal(await rokbotLocalReadPath({ root: ROOT, path: p }), p);
  }
  assert.equal(await rokbotLocalReadPath({ root: ROOT, path: 'notes/today.md' }), `${ROOT}/notes/today.md`);
  assert.equal(await rokbotLocalReadPath({ root: ROOT, path: '~/Desktop/a.txt' }), path.join(os.homedir(), 'Desktop/a.txt'));
});

test('sensitive paths are refused with the real reason, never the workspace wording', async () => {
  const { rokbotLocalReadPath } = loadExtension();
  const home = os.homedir();
  const denied = [
    path.join(home, '.ssh'), path.join(home, '.ssh/id_ed25519'), path.join(home, '.gnupg/private-keys-v1.d/x.key'),
    path.join(home, '.aws/credentials'), path.join(home, '.config/gh/hosts.yml'), path.join(home, '.kube/config'),
    path.join(home, 'Library/Keychains/login.keychain-db'), '/Library/Keychains/System.keychain',
    path.join(home, 'Library/Application Support/Google/Chrome/Default/Login Data'),
    path.join(home, 'Library/Application Support/Firefox/Profiles/abc.default/logins.json'),
    path.join(home, '.rokbot-local/android-signing.json'),
    `${PROFILE}/config.json`, `${PROFILE}/local-exec/approvals.json`,
    '/Volumes/X/project/auth.json', '/Users/x/workspace/credentials.json', '/Users/x/w/secrets.json',
    '/srv/rokbot/data/model.env', '/srv/rokbot/data/setup-key', '/tmp/setup-key.txt', '/Users/x/android-signing.json',
    '~/.ssh/config',
  ];
  for (const p of denied) {
    await assert.rejects(rokbotLocalReadPath({ root: ROOT, path: p }), error => {
      assert.match(error.message, /sensitive/i, p);
      assert.ok(!error.message.includes(OLD_MESSAGE), p);
      assert.ok(error.message.includes(p), `names the requested path: ${p}`);
      return true;
    }, p);
  }
});

test('the deny list folds case on macOS and Windows and uses Windows paths there', () => {
  const { rokbotSensitiveLocalPath } = loadExtension();
  assert.ok(rokbotSensitiveLocalPath('/Users/x/.SSH/id_rsa', { homes: ['/Users/x'], platform: 'darwin' }));
  assert.equal(rokbotSensitiveLocalPath('/home/x/.SSH/id_rsa', { homes: ['/home/x'], platform: 'linux' }), undefined);
  const win = { homes: ['C:\\Users\\x'], roots: ['C:\\Users\\x\\AppData\\Roaming\\RokBot Local\\local-exec\\workspace'], platform: 'win32' };
  assert.ok(rokbotSensitiveLocalPath('c:\\users\\X\\.ssh\\id_ed25519', win));
  assert.ok(rokbotSensitiveLocalPath('C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Credentials\\ABC', win));
  assert.ok(rokbotSensitiveLocalPath('C:\\Users\\x\\AppData\\Roaming\\RokBot Local\\config.json', win));
  assert.ok(rokbotSensitiveLocalPath('D:\\work\\Auth.JSON', win));
  assert.equal(rokbotSensitiveLocalPath('C:\\Users\\x\\AppData\\Roaming\\RokBot Local\\local-exec\\workspace\\a.txt', win), undefined);
  assert.equal(rokbotSensitiveLocalPath('D:\\work\\report.docx', win), undefined);
});

test('a symlink that points at a sensitive file is refused; one that points at an ordinary file is not', async t => {
  const { rokbotLocalReadPath } = loadExtension();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-local-read-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'RokBot Local'), root = path.join(profile, 'local-exec', 'workspace');
  await mkdir(root, { recursive: true });
  await mkdir(path.join(dir, 'vault'));
  await writeFile(path.join(dir, 'vault', 'credentials.json'), '{"token":"x"}');
  await writeFile(path.join(profile, 'config.json'), '{"token":"x"}');
  await writeFile(path.join(dir, 'photo.png'), 'png');
  await symlink(path.join(dir, 'vault', 'credentials.json'), path.join(dir, 'harmless.txt'));
  await symlink(path.join(profile, 'config.json'), path.join(root, 'settings.txt'));
  await symlink(path.join(dir, 'vault'), path.join(dir, 'linked-dir'));
  await symlink(path.join(dir, 'photo.png'), path.join(dir, 'photo-link.png'));
  for (const p of [path.join(dir, 'harmless.txt'), path.join(root, 'settings.txt')]) {
    await assert.rejects(rokbotLocalReadPath({ root, path: p }), error => /symlink/.test(error.message) && /sensitive/i.test(error.message) && !error.message.includes(OLD_MESSAGE), p);
  }
  // Refused by its own name before the symlink is followed.
  await assert.rejects(rokbotLocalReadPath({ root, path: path.join(dir, 'linked-dir', 'credentials.json') }), /sensitive/i);
  assert.equal(await rokbotLocalReadPath({ root, path: path.join(dir, 'photo-link.png') }), path.join(dir, 'photo-link.png'));
});

test('writes stay inside the workspace and say why when refused', async () => {
  const { rokbotLocalWritePath, rokbotLocalWriteRefusal } = loadExtension();
  assert.equal(await rokbotLocalWritePath({ root: ROOT, path: 'out/a.txt' }), `${ROOT}/out/a.txt`);
  await assert.rejects(rokbotLocalWritePath({ root: ROOT, path: '/Users/x/workspace/a.txt' }), error => {
    assert.ok(!error.message.includes(OLD_MESSAGE));
    assert.match(error.message, /RokBot's local workspace/);
    assert.ok(error.message.includes(ROOT));
    assert.match(error.message, /approval/);
    return true;
  });
  assert.match(rokbotLocalWriteRefusal('/x', ROOT, true), /symlink/);
});

// --- the real patched daemon ----------------------------------------------------------------

const daemonSources = (process.env.ROKBOT_DESKTOP_TEST_LOCAL_EXEC_DAEMON ?? '').split(path.delimiter).filter(Boolean);

async function versionOf(source) {
  const sha = createHash('sha256').update(source).digest('hex');
  for (const [version, dirs] of Object.entries(RECIPE_DIRS)) {
    if ((await committedDaemonRecipe(dirs[0])).sourceSha256 === sha) return version;
  }
  throw new Error(`not a pinned official local-exec daemon (${sha})`);
}

function loadPatchedDaemon(file, source, version) {
  const patched = buildRecipe(localExecDaemonEntry(version), source).target.toString('utf8');
  const daemon = new Module(file);
  daemon.filename = file;
  daemon.paths = [path.join(path.dirname(file), '../deps'), ...Module._nodeModulePaths(path.dirname(file))];
  daemon._compile(patched, file);
  return daemon.exports;
}

for (const file of daemonSources) {
  test(`real daemon ${file}: read and copy-out leave the workspace, sensitive paths and writes do not`, { skip: !existsSync(file) }, async t => {
    const source = readFileSync(file);
    const version = await versionOf(source);
    const original = loadPatchedDaemon(file, source, version);
    const dir = await mkdtemp(path.join(os.tmpdir(), `rokbot-local-read-${version}-`));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = path.join(dir, 'RokBot Local', 'local-exec', 'workspace');
    await mkdir(root, { recursive: true });
    await mkdir(path.join(dir, 'Volumes', 'X'), { recursive: true });
    await writeFile(path.join(dir, 'a.txt'), 'hello outside');
    await writeFile(path.join(dir, 'Volumes', 'X', 'y.png'), 'png bytes');
    await writeFile(path.join(dir, 'auth.json'), '{"token":"x"}');
    await symlink(path.join(dir, 'auth.json'), path.join(dir, 'innocent.txt'));

    const checks = [];
    let refuse;
    const provider = new original.Provider({ root, computerId: 'test', computerLabel: 'test',
      resolveConnection: async () => { throw new Error('offline'); },
      isLocalUseBlocked: async args => { checks.push(args.describes?.action); return refuse?.(args); } });
    t.after(() => provider.close());
    const executor = provider.executor;
    const exec = message => new Promise(resolve => {
      const frames = [];
      executor.handle({ kind: 'exec', requestId: `r${Math.random()}`, serverMessageJson: JSON.stringify(message) }, frame => frames.push(frame))
        .then(() => resolve(frames));
    });
    const file1 = frame => new Promise(resolve => executor.handle(frame, resolve));
    const chunk = frame => new Promise(resolve => {
      provider.enqueue = reply => resolve(reply.message);
      provider.__rokbotHandleTransferFrame({ requestId: `c${Math.random()}`, ...frame });
    });
    const text = frames => JSON.stringify(frames);

    // Read and ls outside the workspace.
    const read = await exec({ readArgs: { path: path.join(dir, 'a.txt') } });
    assert.ok(text(read).includes('hello outside'), text(read));
    // ls gets past the path check; listing itself needs the ripgrep binary the app configures at
    // start-up, which this test does not.
    const listed = text(await exec({ lsArgs: { path: path.join(dir, 'Volumes', 'X') } }));
    assert.ok(!listed.includes(OLD_MESSAGE) && (listed.includes('y.png') || listed.includes('Ripgrep path not configured')), listed);
    // Copy-out (download and the chunked read) outside the workspace.
    const download = await file1({ kind: 'download', requestId: 'd1', path: path.join(dir, 'Volumes', 'X', 'y.png') });
    // 1.3.0 and 1.2.3 stream the file; 0.71.2 returns its bytes in one frame.
    assert.ok(['file-stream', 'file'].includes(download.kind), text(download));
    const chunked = await chunk({ kind: 'file-read-chunk', path: path.join(dir, 'Volumes', 'X', 'y.png'), offset: 0, length: 1024 });
    assert.equal(Buffer.from(chunked.bytesBase64, 'base64').toString(), 'png bytes', text(chunked));
    const hashed = await chunk({ kind: 'file-hash', path: path.join(dir, 'a.txt') });
    assert.equal(hashed.bytes, 13, text(hashed));

    // Sensitive files, directly or through a symlink, are refused with the real reason.
    for (const p of [path.join(dir, 'auth.json'), path.join(dir, 'innocent.txt')]) {
      for (const result of [await exec({ readArgs: { path: p } }), await file1({ kind: 'download', requestId: 'd2', path: p }),
        await chunk({ kind: 'file-read-chunk', path: p, offset: 0, length: 16 })]) {
        assert.match(text(result), /sensitive/i, text(result));
        assert.ok(!text(result).includes(OLD_MESSAGE), text(result));
        assert.ok(!text(result).includes('"token"'), 'no content leaks');
      }
    }

    // Writes into the computer stay inside the workspace, with a message that says so.
    const upload = await file1({ kind: 'upload', requestId: 'u1', path: path.join(dir, 'w.txt'), bytes: Buffer.from('x') });
    assert.equal(upload.kind, 'file-error');
    assert.match(upload.error, /RokBot's local workspace/);
    assert.ok(!upload.error.includes(OLD_MESSAGE), upload.error);
    const inside = await file1({ kind: 'upload', requestId: 'u2', path: path.join(root, 'w.txt'), bytes: Buffer.from('x') });
    assert.equal(inside.kind, 'file', text(inside));
    const begin = await chunk({ kind: 'file-write-begin', transferId: 't1', path: path.join(dir, 'w2.txt') });
    assert.match(begin.error, /RokBot's local workspace/);
    // The local daemon has no write or delete file tool: those go through Shell.
    assert.match(text(await exec({ writeArgs: { path: path.join(root, 'n.txt'), fileText: 'x' } })), /No handler found/);
    assert.match(text(await exec({ deleteArgs: { path: path.join(dir, 'a.txt') } })), /No handler found/);
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello outside');

    // Every read and write still passes the approval / auto-review gate first.
    assert.ok(checks.includes('read-file') && checks.includes('list-directory') && checks.includes('write-file'), checks.join());
    refuse = args => `needs approval: ${args.describes.action}`;
    const gatedRead = await exec({ readArgs: { path: path.join(dir, 'a.txt') } });
    assert.match(text(gatedRead), /needs approval: read-file/);
    assert.ok(!text(gatedRead).includes('hello outside'));
    assert.match((await file1({ kind: 'download', requestId: 'd3', path: path.join(dir, 'a.txt') })).error, /needs approval: read-file/);
    assert.match((await file1({ kind: 'upload', requestId: 'u3', path: path.join(root, 'z.txt'), bytes: Buffer.from('x') })).error, /needs approval: write-file/);
    assert.match((await chunk({ kind: 'file-read-chunk', path: path.join(dir, 'a.txt'), offset: 0, length: 4 })).error, /needs approval: read-file/);
    assert.ok(!existsSync(path.join(root, 'z.txt')));
  });
}
