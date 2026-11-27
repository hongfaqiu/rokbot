import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const releaseDir = join(repoRoot, 'host', 'release');
const composePath = join(releaseDir, 'docker-compose.images.yml');
const envExamplePath = join(releaseDir, '.env.images.example');
const installScriptPath = join(releaseDir, 'install-images.sh');

const ISOLATED_PROJECT = 'rokbot-m2-3-test';
const BASH_BIN = process.platform === 'darwin' ? '/bin/bash' : 'bash';

function hasDockerCompose() {
  const res = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 10_000 });
  return res.status === 0;
}

function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

async function createFakeDocker(binDir, logPath = null) {
  const fakeDocker = join(binDir, 'docker');
  const logLine = logPath ? `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}` : ':';
  const script = `#!/usr/bin/env bash
set -euo pipefail
${logLine}
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  echo "Docker Compose version v5.1.3"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  shift
  if [[ "\${1:-}" == "up" && "\${2:-}" == "--help" ]]; then
    echo "Usage: docker compose up [OPTIONS] [SERVICE...]"
    echo "      --pull string     Pull image before running"
    echo "      --wait            Wait for services to be running|healthy"
    echo "      --wait-timeout int Maximum duration in seconds to wait"
    exit 0
  fi
  env_file=""
  want_env=0
  want_images=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env-file) env_file="\${2:-}"; shift 2 ;;
      --environment) want_env=1; shift ;;
      --images) want_images=1; shift ;;
      *) shift ;;
    esac
  done
  if [[ "$want_env" == "1" && -n "$env_file" && -f "$env_file" ]]; then
    grep -E "^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=" "$env_file" || true
    exit 0
  fi
  if [[ "$want_images" == "1" ]]; then
    echo "ghcr.io/hongfaqiu/rokbot/host:latest"
    echo "ghcr.io/hongfaqiu/rokbot/box:2bb5e41"
    exit 0
  fi
  exit 0
fi
if [[ "\${1:-}" == "image" && "\${2:-}" == "ls" ]]; then
  exit 0
fi
exit 0
`;
  await writeFile(fakeDocker, script, { mode: 0o755 });
  await chmod(fakeDocker, 0o755);
}

test('static Compose and .env.images.example schema match RokBot prebuilt image contracts', async () => {
  const [compose, envExample, installScript, scriptStat] = await Promise.all([
    readFile(composePath, 'utf8'),
    readFile(envExamplePath, 'utf8'),
    readFile(installScriptPath, 'utf8'),
    stat(installScriptPath),
  ]);

  if (process.platform !== 'win32') {
    assert.ok((scriptStat.mode & 0o111) !== 0, 'install-images.sh must be executable');
  }

  assert.match(compose, /^name:\s*rokbot\b/m);
  assert.match(compose, /x-proxy-environment:\s*&proxy-environment/);
  assert.ok(compose.includes('ghcr.io/hongfaqiu/rokbot/host:latest'));
  assert.ok(compose.includes('ghcr.io/hongfaqiu/rokbot/box:97658ad'));
  assert.match(compose, /platform:\s*linux\/amd64/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s*-\s*ALL/);
  assert.match(compose, /host\.docker\.internal:host-gateway/);
  assert.match(compose, /ROKBOT_PORT:\s*["']?8000["']?/);
  assert.match(compose, /ROKBOT_BIND:\s*["']?0\.0\.0\.0["']?/);
  assert.match(compose, /:8000["']?\s*$/m);
  assert.match(compose, /ROKBOT_ALLOW_DEVICE_MODEL_CONFIG:\s*\$\{ROKBOT_ALLOW_DEVICE_MODEL_CONFIG:-1\}/);
  assert.match(compose, /ROKBOT_UPDATE_DIR:\s*\$\{ROKBOT_UPDATE_DIR:-\/data\/updates\}/);
  assert.match(compose, /ROKBOT_UPDATE_UPSTREAM_ORIGIN:/);
  assert.match(compose, /ROKBOT_BOX_TOKEN:\s*\$\{ROKBOT_BOX_TOKEN:-local\}/);
  assert.match(compose, /healthcheck:/);
  assert.match(compose, /deploy\/healthcheck\.mjs/);
  assert.match(compose, /timeout:\s*15s/);
  assert.match(compose, /host-data:\/data/);
  assert.match(compose, /box-home:\/home\/box/);
  assert.match(compose, /box-workspace:\/workspace/);
  assert.doesNotMatch(compose, /^\s+user:/m, 'Compose must omit user: so host /data and box start-sand-box work');

  // Ensure box service does not drop capabilities or set no-new-privileges.
  const boxSection = compose.slice(compose.indexOf('\n  box:'), compose.indexOf('\nvolumes:'));
  assert.doesNotMatch(boxSection, /cap_drop|no-new-privileges|security_opt/);

  assert.match(envExample, /^ROKBOT_LISTEN_ADDRESS=127\.0\.0\.1$/m);
  assert.match(envExample, /^ROKBOT_PUBLIC_PORT=18080$/m);
  assert.match(envExample, /^ROKBOT_HOST_IMAGE=ghcr\.io\/hongfaqiu\/rokbot\/host:latest$/m);
  assert.match(envExample, /^ROKBOT_BOX_IMAGE=ghcr\.io\/hongfaqiu\/rokbot\/box:97658ad$/m);
  assert.match(envExample, /^ROKBOT_ALLOW_DEVICE_MODEL_CONFIG=1$/m);
  assert.match(envExample, /^ROKBOT_UPDATE_DIR=\/data\/updates$/m);
  assert.match(envExample, /^ROKBOT_BOX_TOKEN=local$/m);
  assert.match(envExample, /^#\s*ROKBOT_ADMIN_PASSWORD=$/m, 'ROKBOT_ADMIN_PASSWORD must be commented out in template');
  assert.match(envExample, /^#\s*ROKBOT_SETUP_KEY=$/m, 'ROKBOT_SETUP_KEY must be commented out in template');
  assert.doesNotMatch(envExample, /^ROKBOT_ADMIN_PASSWORD=/m, 'ROKBOT_ADMIN_PASSWORD must not be active in template');
  assert.doesNotMatch(envExample, /^ROKBOT_SETUP_KEY=/m, 'ROKBOT_SETUP_KEY must not be active in template');
  assert.ok(envExample.includes('/data/setup-key'), '.env.images.example must explain /data/setup-key');
  assert.ok(envExample.includes('host-admin.mjs'), '.env.images.example must explain host-admin.mjs CLI usage');

  for (const [name, content] of [
    ['docker-compose.images.yml', compose],
    ['.env.images.example', envExample],
    ['install-images.sh', installScript],
  ]) {
    assert.doesNotMatch(content, /grokbot/i, `${name} must not contain grokbot references`);
  }
  assert.ok(installScript.includes('https://raw.githubusercontent.com/hongfaqiu/rokbot/'));
});

test('real docker compose validates docker-compose.images.yml and resolves defaults', { skip: !hasDockerCompose() }, () => {
  const quietRes = spawnSync(
    'docker',
    ['compose', '--env-file', envExamplePath, '-f', composePath, 'config', '--quiet'],
    {
      encoding: 'utf8',
      env: { ...process.env, COMPOSE_PROJECT_NAME: ISOLATED_PROJECT },
      timeout: 15_000,
    },
  );
  assert.equal(quietRes.status, 0, quietRes.stdout + quietRes.stderr);

  const resolvedRes = spawnSync(
    'docker',
    ['compose', '--env-file', '/dev/null', '-f', composePath, 'config'],
    {
      encoding: 'utf8',
      env: { ...process.env, COMPOSE_PROJECT_NAME: ISOLATED_PROJECT },
      timeout: 15_000,
    },
  );
  assert.equal(resolvedRes.status, 0, resolvedRes.stdout + resolvedRes.stderr);
  const out = resolvedRes.stdout;
  assert.ok(out.includes('ghcr.io/hongfaqiu/rokbot/host:latest'));
  assert.ok(out.includes('ghcr.io/hongfaqiu/rokbot/box:97658ad'));
  assert.ok(out.includes('published: "18080"'));
  assert.ok(out.includes('target: 8000'));
  assert.ok(out.includes('ROKBOT_ALLOW_DEVICE_MODEL_CONFIG: "1"'));
  assert.ok(out.includes('ROKBOT_UPDATE_DIR: /data/updates'));
  assert.ok(out.includes('timeout: 15s'));
});

test('install-images.sh CLI flags, download scheme validation, and --offline guard', { skip: process.platform === 'win32' }, async t => {
  const syntaxRes = spawnSync(BASH_BIN, ['-n', installScriptPath], { encoding: 'utf8' });
  assert.equal(syntaxRes.status, 0, syntaxRes.stderr);

  const helpRes = spawnSync(BASH_BIN, [installScriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(helpRes.status, 0, helpRes.stderr);
  assert.match(helpRes.stdout, /Usage:/);
  assert.match(helpRes.stdout, /--prepare-only/);

  const badArgRes = spawnSync(BASH_BIN, [installScriptPath, '--not-a-valid-flag'], { encoding: 'utf8' });
  assert.equal(badArgRes.status, 2);
  assert.match(badArgRes.stderr, /Usage:/);

  const httpRes = spawnSync(BASH_BIN, [installScriptPath, '--prepare-only'], {
    encoding: 'utf8',
    env: { ...process.env, ROKBOT_DOWNLOAD_BASE: 'http://insecure.example/release' },
  });
  assert.equal(httpRes.status, 1);
  assert.match(httpRes.stderr, /https:\/\/ or file:\/\//);

  const emptyDir = await mkdtemp(join(tmpdir(), 'rokbot-offline-missing-'));
  t.after(() => rm(emptyDir, { recursive: true, force: true }));
  const standaloneScript = join(emptyDir, 'install-images.sh');
  await copyFile(installScriptPath, standaloneScript);
  await chmod(standaloneScript, 0o755);

  const offlineRes = spawnSync(BASH_BIN, [standaloneScript, '--offline', '--prepare-only'], {
    cwd: emptyDir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: emptyDir },
  });
  assert.equal(offlineRes.status, 1);
  assert.match(offlineRes.stderr, /--offline requires local/);
});

test('install-images.sh --local --prepare-only and file:// download create 0600 .env without decoy secrets', { skip: process.platform === 'win32' }, async t => {
  const workDirLocal = await mkdtemp(join(tmpdir(), 'rokbot-local-prep-'));
  const workDirFile = await mkdtemp(join(tmpdir(), 'rokbot-file-prep-'));
  t.after(async () => {
    await rm(workDirLocal, { recursive: true, force: true });
    await rm(workDirFile, { recursive: true, force: true });
  });

  const fakeBin = join(workDirLocal, '_bin');
  await mkdir(fakeBin, { recursive: true });
  await createFakeDocker(fakeBin);

  // 1. --local --prepare-only from an empty temp dir resolves templates beside install-images.sh.
  const localRes = spawnSync(BASH_BIN, [installScriptPath, '--local', '--prepare-only'], {
    cwd: workDirLocal,
    encoding: 'utf8',
    env: { PATH: `${fakeBin}:${process.env.PATH || '/usr/bin:/bin'}`, HOME: workDirLocal },
  });
  assert.equal(localRes.status, 0, localRes.stdout + localRes.stderr);
  assert.match(localRes.stdout, /RokBot files are ready/);

  const localEnvPath = join(workDirLocal, '.env');
  const localStat = await stat(localEnvPath);
  assert.equal(localStat.mode & 0o777, 0o600);
  const localEnvRaw = await readFile(localEnvPath, 'utf8');
  const localEnv = parseEnv(localEnvRaw);
  assert.equal(localEnv.ROKBOT_ADMIN_PASSWORD, undefined, 'must not generate decoy ROKBOT_ADMIN_PASSWORD');
  assert.equal(localEnv.ROKBOT_SETUP_KEY, undefined, 'must not generate decoy ROKBOT_SETUP_KEY');
  assert.equal(localEnv.ROKBOT_BOX_TOKEN, 'local');

  if (hasDockerCompose()) {
    const composeRes = spawnSync(
      'docker',
      ['compose', '--env-file', localEnvPath, '-f', join(workDirLocal, 'docker-compose.images.yml'), 'config', '--quiet'],
      { encoding: 'utf8', env: { ...process.env, COMPOSE_PROJECT_NAME: ISOLATED_PROJECT } },
    );
    assert.equal(composeRes.status, 0, composeRes.stdout + composeRes.stderr);
  }

  // 2. ROKBOT_DOWNLOAD_BASE=file://... --prepare-only downloads templates via curl file://.
  const standaloneScript = join(workDirFile, 'install-images.sh');
  await copyFile(installScriptPath, standaloneScript);
  await chmod(standaloneScript, 0o755);

  const fileRes = spawnSync(BASH_BIN, [standaloneScript, '--prepare-only'], {
    cwd: workDirFile,
    encoding: 'utf8',
    env: {
      PATH: `${fakeBin}:${process.env.PATH || '/usr/bin:/bin'}`,
      HOME: workDirFile,
      ROKBOT_DOWNLOAD_BASE: pathToFileURL(releaseDir).href,
    },
  });
  assert.equal(fileRes.status, 0, fileRes.stdout + fileRes.stderr);
  const fileEnvPath = join(workDirFile, '.env');
  assert.equal((await stat(fileEnvPath)).mode & 0o777, 0o600);
  const fileEnv = parseEnv(await readFile(fileEnvPath, 'utf8'));
  assert.equal(fileEnv.ROKBOT_ADMIN_PASSWORD, undefined, 'must not generate decoy ROKBOT_ADMIN_PASSWORD');
  assert.equal(fileEnv.ROKBOT_SETUP_KEY, undefined, 'must not generate decoy ROKBOT_SETUP_KEY');
  assert.equal(fileEnv.ROKBOT_BOX_TOKEN, 'local');

  if (hasDockerCompose()) {
    const composeRes = spawnSync(
      'docker',
      ['compose', '--env-file', fileEnvPath, '-f', join(workDirFile, 'docker-compose.images.yml'), 'config', '--quiet'],
      { encoding: 'utf8', env: { ...process.env, COMPOSE_PROJECT_NAME: ISOLATED_PROJECT } },
    );
    assert.equal(composeRes.status, 0, composeRes.stdout + composeRes.stderr);
  }
});

test('install-images.sh is idempotent on re-run, allows blank CLI placeholders, and appends missing ROKBOT_BOX_TOKEN safely without trailing newline', { skip: process.platform === 'win32' }, async t => {
  const workDir = await mkdtemp(join(tmpdir(), 'rokbot-idempotent-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const fakeBin = join(workDir, '_bin');
  await mkdir(fakeBin, { recursive: true });
  await createFakeDocker(fakeBin);
  const env = { PATH: `${fakeBin}:${process.env.PATH || '/usr/bin:/bin'}`, HOME: workDir };

  const first = spawnSync(BASH_BIN, [installScriptPath, '--local', '--prepare-only'], {
    cwd: workDir,
    encoding: 'utf8',
    env,
  });
  assert.equal(first.status, 0, first.stdout + first.stderr);

  const envPath = join(workDir, '.env');
  // Strip ROKBOT_BOX_TOKEN, add blank optional CLI vars + custom comment + quoted value, remove trailing newline.
  const modified = (await readFile(envPath, 'utf8'))
    .split('\n')
    .filter(line => !line.startsWith('ROKBOT_BOX_TOKEN='))
    .join('\n')
    .trimEnd() + '\nROKBOT_ADMIN_PASSWORD=\nROKBOT_SETUP_KEY=\n# custom operator comment\nCUSTOM_NOTE="keep # this"';
  await writeFile(envPath, modified, { mode: 0o600 });

  const second = spawnSync(BASH_BIN, [installScriptPath, '--local', '--prepare-only'], {
    cwd: workDir,
    encoding: 'utf8',
    env,
  });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /Keeping existing \.env\./);

  const afterSecond = await readFile(envPath, 'utf8');
  assert.ok(afterSecond.includes('# custom operator comment\nCUSTOM_NOTE="keep # this"\nROKBOT_BOX_TOKEN=local\n'));
  const secondParsed = parseEnv(afterSecond);
  assert.equal(secondParsed.ROKBOT_ADMIN_PASSWORD, '');
  assert.equal(secondParsed.ROKBOT_SETUP_KEY, '');
  assert.equal(secondParsed.ROKBOT_BOX_TOKEN, 'local');
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);

  // Third run must leave .env byte-for-byte identical.
  const third = spawnSync(BASH_BIN, [installScriptPath, '--local', '--prepare-only'], {
    cwd: workDir,
    encoding: 'utf8',
    env,
  });
  assert.equal(third.status, 0, third.stdout + third.stderr);
  assert.equal(await readFile(envPath, 'utf8'), afterSecond);
});

test('install-images.sh parses quoted .env proxy vars safely in Bash 3.2 and wires offline override flow', { skip: process.platform === 'win32' }, async t => {
  const proxyDir = await mkdtemp(join(tmpdir(), 'rokbot-proxy-parse-'));
  const offlineDir = await mkdtemp(join(tmpdir(), 'rokbot-offline-up-'));
  t.after(async () => {
    await rm(proxyDir, { recursive: true, force: true });
    await rm(offlineDir, { recursive: true, force: true });
  });

  // Part A: quote-aware proxy parsing & Bash 3.2 edge cases via fake curl shim.
  const proxyBin = join(proxyDir, '_bin');
  await mkdir(proxyBin, { recursive: true });
  await createFakeDocker(proxyBin);

  const curlLogPath = join(proxyDir, 'curl-env.log');
  const fakeCurl = join(proxyBin, 'curl');
  const fakeCurlScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--help" ]]; then
  exit 0
fi
url=""
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="\${2:-}"; shift 2 ;;
    --proto-redir|--retry|--retry-delay) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf 'http_proxy=%s\\nhttps_proxy=%s\\nno_proxy=%s\\n' "\${http_proxy:-}" "\${https_proxy:-}" "\${no_proxy:-}" > ${JSON.stringify(curlLogPath)}
case "$url" in
  */docker-compose.images.yml) cp ${JSON.stringify(composePath)} "$out" ;;
  */.env.images.example) cp ${JSON.stringify(envExamplePath)} "$out" ;;
  *) exit 1 ;;
esac
`;
  await writeFile(fakeCurl, fakeCurlScript, { mode: 0o755 });
  await chmod(fakeCurl, 0o755);

  const standaloneProxyScript = join(proxyDir, 'install-images.sh');
  await copyFile(installScriptPath, standaloneProxyScript);
  await chmod(standaloneProxyScript, 0o755);

  const proxyEnvContent = [
    'ROKBOT_BOX_TOKEN=local',
    "HTTPS_PROXY='http://user:p#ss@proxy.local:8080' # trailing comment",
    'HTTP_PROXY="http://a\\"b\\\\c#d@127.0.0.1:7890"',
    'NO_PROXY=localhost,127.0.0.1 # local only',
    'FOO=',
    'BAR="',
    '',
  ].join('\r\n');
  await writeFile(join(proxyDir, '.env'), proxyEnvContent, { mode: 0o600 });

  const proxyRes = spawnSync(BASH_BIN, [standaloneProxyScript, '--prepare-only'], {
    cwd: proxyDir,
    encoding: 'utf8',
    env: {
      PATH: `${proxyBin}:/usr/bin:/bin`,
      HOME: proxyDir,
      ROKBOT_DOWNLOAD_BASE: 'https://mock.rokbot.test/release',
    },
  });
  assert.equal(proxyRes.status, 0, proxyRes.stdout + proxyRes.stderr);
  const loggedProxy = await readFile(curlLogPath, 'utf8');
  assert.ok(loggedProxy.includes('http_proxy=http://a"b\\c#d@127.0.0.1:7890\n'), loggedProxy);
  assert.ok(loggedProxy.includes('https_proxy=http://user:p#ss@proxy.local:8080\n'), loggedProxy);
  assert.ok(loggedProxy.includes('no_proxy=localhost,127.0.0.1\n'), loggedProxy);

  // Shell-set HTTPS_PROXY must override .env HTTPS_PROXY.
  const overrideRes = spawnSync(BASH_BIN, [standaloneProxyScript, '--prepare-only'], {
    cwd: proxyDir,
    encoding: 'utf8',
    env: {
      PATH: `${proxyBin}:/usr/bin:/bin`,
      HOME: proxyDir,
      ROKBOT_DOWNLOAD_BASE: 'https://mock.rokbot.test/release',
      HTTPS_PROXY: 'http://shell.override:3128',
    },
  });
  assert.equal(overrideRes.status, 0, overrideRes.stdout + overrideRes.stderr);
  const loggedOverride = await readFile(curlLogPath, 'utf8');
  assert.ok(loggedOverride.includes('https_proxy=http://shell.override:3128\n'), loggedOverride);

  // Part B: --offline with docker-compose.override.yml never calls curl or pull, and prints accurate onboarding guide.
  const offlineBin = join(offlineDir, '_bin');
  await mkdir(offlineBin, { recursive: true });
  const dockerLogPath = join(offlineDir, 'docker.log');
  await createFakeDocker(offlineBin, dockerLogPath);

  const failingCurl = join(offlineBin, 'curl');
  await writeFile(failingCurl, '#!/usr/bin/env bash\necho "curl must not be called in --offline mode" >&2\nexit 99\n', { mode: 0o755 });
  await chmod(failingCurl, 0o755);

  await copyFile(installScriptPath, join(offlineDir, 'install-images.sh'));
  await chmod(join(offlineDir, 'install-images.sh'), 0o755);
  await copyFile(composePath, join(offlineDir, 'docker-compose.images.yml'));
  await copyFile(envExamplePath, join(offlineDir, '.env.images.example'));
  await writeFile(join(offlineDir, 'docker-compose.override.yml'), 'services:\n  host:\n    environment:\n      TZ: UTC\n');

  const offlineUp = spawnSync(BASH_BIN, [join(offlineDir, 'install-images.sh'), '--offline'], {
    cwd: offlineDir,
    encoding: 'utf8',
    env: {
      PATH: `${offlineBin}:/usr/bin:/bin`,
      HOME: offlineDir,
    },
  });
  assert.equal(offlineUp.status, 0, offlineUp.stdout + offlineUp.stderr);
  const dockerLog = await readFile(dockerLogPath, 'utf8');
  assert.doesNotMatch(dockerLog, /\bpull\b(?!\s+never)/);
  assert.match(dockerLog, /-f docker-compose\.images\.yml -f docker-compose\.override\.yml up -d --pull never --wait --wait-timeout 300/);
  assert.match(offlineUp.stdout, /http:\/\/127\.0\.0\.1:18080\/admin/);
  assert.match(offlineUp.stdout, /exec -T host cat \/data\/setup-key/);
  assert.match(offlineUp.stdout, /ROKBOT_BOX_TOKEN/);
  assert.doesNotMatch(offlineUp.stdout, /contains ROKBOT_ADMIN_PASSWORD \/ ROKBOT_SETUP_KEY/);
});

test('install-images.sh handles spaces around =, export prefix, whitespace-only token repair, 0644->0600 tightening, and IPv6 ::1 URLs', { skip: process.platform === 'win32' }, async t => {
  const spacedDir = await mkdtemp(join(tmpdir(), 'rokbot-spaced-env-'));
  const repairDir = await mkdtemp(join(tmpdir(), 'rokbot-repair-env-'));
  const ipv6Dir = await mkdtemp(join(tmpdir(), 'rokbot-ipv6-env-'));
  t.after(async () => {
    await rm(spacedDir, { recursive: true, force: true });
    await rm(repairDir, { recursive: true, force: true });
    await rm(ipv6Dir, { recursive: true, force: true });
  });

  // 1. KEY = value spaces around = and export HTTPS_PROXY=...
  const spacedBin = join(spacedDir, '_bin');
  await mkdir(spacedBin, { recursive: true });
  await createFakeDocker(spacedBin);
  const curlLogPath = join(spacedDir, 'curl-env.log');
  const fakeCurl = join(spacedBin, 'curl');
  await writeFile(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--help" ]]; then exit 0; fi
url="" out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="\${2:-}"; shift 2 ;;
    --proto-redir|--retry|--retry-delay) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf 'http_proxy=%s\\nhttps_proxy=%s\\n' "\${http_proxy:-}" "\${https_proxy:-}" > ${JSON.stringify(curlLogPath)}
case "$url" in
  */docker-compose.images.yml) cp ${JSON.stringify(composePath)} "$out" ;;
  */.env.images.example) cp ${JSON.stringify(envExamplePath)} "$out" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  await chmod(fakeCurl, 0o755);

  const spacedScript = join(spacedDir, 'install-images.sh');
  await copyFile(installScriptPath, spacedScript);
  await chmod(spacedScript, 0o755);
  const spacedEnvBefore = [
    'ROKBOT_BOX_TOKEN = customtoken',
    'ROKBOT_PUBLIC_PORT = 19090',
    'HTTP_PROXY = http://spaced:8080',
    'export HTTPS_PROXY=http://exported:9999',
    '',
  ].join('\n');
  await writeFile(join(spacedDir, '.env'), spacedEnvBefore, { mode: 0o600 });

  const spacedRes = spawnSync(BASH_BIN, [spacedScript, '--pull-never'], {
    cwd: spacedDir,
    encoding: 'utf8',
    env: {
      PATH: `${spacedBin}:/usr/bin:/bin`,
      HOME: spacedDir,
      ROKBOT_DOWNLOAD_BASE: 'https://mock.rokbot.test/release',
    },
  });
  assert.equal(spacedRes.status, 0, spacedRes.stdout + spacedRes.stderr);
  assert.equal(await readFile(join(spacedDir, '.env'), 'utf8'), spacedEnvBefore, 'ROKBOT_BOX_TOKEN = customtoken must not trigger duplicate append');
  const spacedCurlLog = await readFile(curlLogPath, 'utf8');
  assert.ok(spacedCurlLog.includes('http_proxy=http://spaced:8080\n'), spacedCurlLog);
  assert.ok(spacedCurlLog.includes('https_proxy=http://exported:9999\n'), spacedCurlLog);
  assert.match(spacedRes.stdout, /Local URL:\s+http:\/\/127\.0\.0\.1:19090/);

  if (hasDockerCompose()) {
    const composeRes = spawnSync(
      'docker',
      ['compose', '--env-file', join(spacedDir, '.env'), '-f', join(spacedDir, 'docker-compose.images.yml'), 'config', '--quiet'],
      { encoding: 'utf8', env: { ...process.env, COMPOSE_PROJECT_NAME: ISOLATED_PROJECT } },
    );
    assert.equal(composeRes.status, 0, composeRes.stdout + composeRes.stderr);
  }

  // 2. Quoted whitespace-only ROKBOT_BOX_TOKEN="   " repaired to local + 0644 -> 0600 permission tightening.
  const repairBin = join(repairDir, '_bin');
  await mkdir(repairBin, { recursive: true });
  await createFakeDocker(repairBin);
  const repairEnvPath = join(repairDir, '.env');
  await writeFile(repairEnvPath, 'ROKBOT_BOX_TOKEN="   "\n', { mode: 0o644 });
  await chmod(repairEnvPath, 0o644);

  const repairRes = spawnSync(BASH_BIN, [installScriptPath, '--local', '--prepare-only'], {
    cwd: repairDir,
    encoding: 'utf8',
    env: { PATH: `${repairBin}:${process.env.PATH || '/usr/bin:/bin'}`, HOME: repairDir },
  });
  assert.equal(repairRes.status, 0, repairRes.stdout + repairRes.stderr);
  assert.equal((await stat(repairEnvPath)).mode & 0o777, 0o600, 're-run must tighten 0644 .env to 0600');
  const repairedEnvText = await readFile(repairEnvPath, 'utf8');
  assert.match(repairedEnvText, /^ROKBOT_BOX_TOKEN=local$/m);

  if (hasDockerCompose()) {
    const composeRes = spawnSync(
      'docker',
      ['compose', '--env-file', repairEnvPath, '-f', join(repairDir, 'docker-compose.images.yml'), 'config', '--quiet'],
      { encoding: 'utf8', env: { ...process.env, COMPOSE_PROJECT_NAME: ISOLATED_PROJECT } },
    );
    assert.equal(composeRes.status, 0, composeRes.stdout + composeRes.stderr);
  }

  // 3. IPv6 ::1 URL bracketing in onboarding output.
  const ipv6Bin = join(ipv6Dir, '_bin');
  await mkdir(ipv6Bin, { recursive: true });
  await createFakeDocker(ipv6Bin);
  await copyFile(installScriptPath, join(ipv6Dir, 'install-images.sh'));
  await chmod(join(ipv6Dir, 'install-images.sh'), 0o755);
  await copyFile(composePath, join(ipv6Dir, 'docker-compose.images.yml'));
  await copyFile(envExamplePath, join(ipv6Dir, '.env.images.example'));
  await writeFile(join(ipv6Dir, '.env'), 'ROKBOT_LISTEN_ADDRESS=::1\nROKBOT_PUBLIC_PORT=18080\nROKBOT_BOX_TOKEN=local\n', { mode: 0o600 });

  const ipv6Res = spawnSync(BASH_BIN, [join(ipv6Dir, 'install-images.sh'), '--offline'], {
    cwd: ipv6Dir,
    encoding: 'utf8',
    env: { PATH: `${ipv6Bin}:/usr/bin:/bin`, HOME: ipv6Dir },
  });
  assert.equal(ipv6Res.status, 0, ipv6Res.stdout + ipv6Res.stderr);
  assert.match(ipv6Res.stdout, /Local URL:\s+http:\/\/\[::1\]:18080/);
  assert.match(ipv6Res.stdout, /Admin Console:\s+http:\/\/\[::1\]:18080\/admin/);
});
