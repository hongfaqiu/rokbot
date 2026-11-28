import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Bot avatar page > Generate. The official RN client (1.26.0 build 3212, 1.27.0 build 3283) calls
// /aiserver.v1.AiService/RunGenerateImage through the same RPC transport as TextToSpeech, with
// { description: <full avatar prompt>, modelId: 'grok-4.5', maxMode: false, aspectRatio: '1:1' }
// and reads { success: { imageData } } or { error: { error, ... } } (Hermes: AvatarGeneration.request
// / reply / failure). No interceptor mapped it, so it reached the Host unchanged and got a 404,
// which the pane shows as "Unable to generate avatar. Please retry." Each interceptor now forwards
// it to the Host's /local/avatar/generate with the device token and Accept: application/json.
const NATIVE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const RPC = '/aiserver.v1.AiService/RunGenerateImage';

for (const name of ['R8OkHttpInterceptor127.java', 'R8OkHttpInterceptor126.java', 'R8OkHttpInterceptor.java', 'NetworkInterceptor.java']) {
  test(`${name} forwards RunGenerateImage (avatar Generate) to the Host`, () => {
    const source = fs.readFileSync(path.join(SOURCE_DIR, name), 'utf8');
    assert.match(source, /boolean isAvatarImage = "POST"\.equals\(httpMethod\)\s*&& GatewayEndpointRouter\.AVATAR_IMAGE_RPC\.equals\(path\);/);
    // Unpaired: answered on the device, never sent to the cloud.
    const flags = source.match(/\(isVoiceMint \|\| [^)]*\)/g) ?? [];
    assert.equal(flags.filter(list => list.includes('isAvatarImage')).length, 2, 'token check and no-Host fallback both cover RunGenerateImage');
    const branch = source.indexOf('} else if (isAvatarImage) {');
    assert.ok(branch > 0, 'rewrites the request body');
    const block = source.slice(branch, source.indexOf('} else if (isAppIntent)', branch));
    assert.match(block, /GatewayEndpointRouter\.normalizeAvatarImageBody\(/);
    assert.match(block, /MAX_AVATAR_REQ_BYTES/);
    assert.match(block, /jsonErrorResponse\(request, 400,/);
    assert.match(block, /"Content-Type", "application\/json"/);
    assert.ok(source.indexOf('rewriteRpcPath(path)') < branch, 'uses the rewritten Host path');
  });
}

test('GatewayEndpointRouter maps RunGenerateImage to /local/avatar/generate', () => {
  const source = fs.readFileSync(path.join(SOURCE_DIR, 'GatewayEndpointRouter.java'), 'utf8');
  assert.match(source, new RegExp(`AVATAR_IMAGE_RPC = "${RPC.replace(/[./]/g, '\\$&')}"`));
  assert.match(source, /if \(AVATAR_IMAGE_RPC\.equals\(path\)\) \{\s*return "\/local\/avatar\/generate";/);
});

test('the committed companion dex contains the RunGenerateImage mapping', () => {
  const dex = fs.readFileSync(path.join(NATIVE_ROOT, 'bin/classes2.dex'));
  assert.ok(dex.includes(Buffer.from(RPC)), 'RPC path');
  assert.ok(dex.includes(Buffer.from('/local/avatar/generate')), 'Host path');
  assert.ok(dex.includes(Buffer.from('normalizeAvatarImageBody')), 'body normalizer');
});

test('GatewayEndpointRouter routes and normalizes RunGenerateImage (JVM)', (t) => {
  const sdkRoot = [process.env.ANDROID_HOME, path.join(os.homedir(), 'Library/Android/sdk'), '/Users/lianqishi/Library/Android/sdk']
    .find(dir => dir && fs.existsSync(path.join(dir, 'platforms/android-36/android.jar')));
  const javac = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  if (!sdkRoot || !javac) return t.skip('Android SDK (android-36) and a JDK are required');
  const java = javac.endsWith('javac') ? javac.slice(0, -1) : 'java';
  const androidJar = path.join(sdkRoot, 'platforms/android-36/android.jar');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-avatar-rpc-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.java')) files.push(full);
    }
  };
  walk(path.join(NATIVE_ROOT, 'companion/compile-stubs/src/main/java'));
  walk(path.join(NATIVE_ROOT, 'companion/src/main/java'));
  const harness = path.join(tmp, 'AvatarImageRpcHarness.java');
  // android.jar's org.json is a stub, so the body normalizer is checked on a device, not here.
  fs.writeFileSync(harness, `
import dev.rokbot.nativeapp.GatewayEndpointRouter;
public class AvatarImageRpcHarness {
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }
  public static void main(String[] args) {
    check("/local/avatar/generate".equals(GatewayEndpointRouter.rewriteRpcPath("${RPC}")), "RunGenerateImage");
    check("/local/audio/speech".equals(GatewayEndpointRouter.rewriteRpcPath("/aiserver.v1.AiService/TextToSpeech")), "TextToSpeech unchanged");
    check("${RPC}/x".equals(GatewayEndpointRouter.rewriteRpcPath("${RPC}/x")), "exact path");
    check(GatewayEndpointRouter.normalizeAvatarImageBody(null) == null, "missing body");
    check(GatewayEndpointRouter.normalizeAvatarImageBody(new byte[0]) == null, "empty body");
    System.out.println("AVATAR_RPC_OK");
  }
}
`);
  const classes = path.join(tmp, 'classes');
  fs.mkdirSync(classes);
  cp.execFileSync(javac, ['--release', '17', '-encoding', 'UTF-8', '-nowarn', '-cp', androidJar, '-d', classes, ...files, harness], { stdio: 'pipe' });
  const out = cp.execFileSync(java, ['-cp', `${classes}:${androidJar}`, 'AvatarImageRpcHarness'], { encoding: 'utf8' });
  assert.match(out, /AVATAR_RPC_OK/);
});
