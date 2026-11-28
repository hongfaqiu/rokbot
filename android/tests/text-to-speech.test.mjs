import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Voice memos (`voice_memo: true` text messages) are synthesized by the RN client itself through
// /aiserver.v1.AiService/TextToSpeech ({ text, voiceId } -> { audio: base64, mimeType }). Without a
// mapping the request reached the Host unchanged and playback failed. Each interceptor forwards it
// to the Host's /local/audio/speech with the device token and Accept: application/json.
const NATIVE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const RPC = '/aiserver.v1.AiService/TextToSpeech';

for (const name of ['R8OkHttpInterceptor126.java', 'R8OkHttpInterceptor.java', 'NetworkInterceptor.java']) {
  test(`${name} forwards TextToSpeech to the Host like TranscribeAudio`, () => {
    const source = fs.readFileSync(path.join(SOURCE_DIR, name), 'utf8');
    assert.match(source, /boolean isTextToSpeech = "POST"\.equals\(httpMethod\)\s*&& GatewayEndpointRouter\.TEXT_TO_SPEECH_RPC\.equals\(path\);/);
    // Unpaired: answered on the device, never sent to the cloud.
    assert.equal(source.split('(isVoiceMint || isTranscribe || isTextToSpeech || isAppIntent || isDashboard)').length - 1, 2,
      'token check and no-Host fallback both cover TextToSpeech');
    const branch = source.indexOf('} else if (isTextToSpeech) {');
    assert.ok(branch > 0, 'rewrites the request body');
    const block = source.slice(branch, source.indexOf('} else if (isAppIntent)', branch));
    assert.match(block, /GatewayEndpointRouter\.normalizeTextToSpeechBody\(/);
    assert.match(block, /MAX_SPEECH_REQ_BYTES/);
    assert.match(block, /jsonErrorResponse\(request, 400,/);
    assert.match(block, /"Content-Type", "application\/json"/);
    assert.ok(source.indexOf('rewriteRpcPath(path)') < branch, 'uses the rewritten Host path');
    // Accept: application/json makes the Host reply in the RPC's JSON shape.
    assert.match(source, /hasSseAcceptHeader\(request\.(header|h)\("Accept"\)\)\) \{\s*newReq\.(header|e)\("Accept", "application\/json"\);/);
  });
}

test('GatewayEndpointRouter maps TextToSpeech next to TranscribeAudio', () => {
  const source = fs.readFileSync(path.join(SOURCE_DIR, 'GatewayEndpointRouter.java'), 'utf8');
  assert.match(source, new RegExp(`TEXT_TO_SPEECH_RPC = "${RPC.replace(/[./]/g, '\\$&')}"`));
  assert.match(source, /if \(TEXT_TO_SPEECH_RPC\.equals\(path\)\) \{\s*return "\/local\/audio\/speech";/);
});

test('the committed companion dex contains the TextToSpeech mapping', () => {
  const dex = fs.readFileSync(path.join(NATIVE_ROOT, 'bin/classes2.dex'));
  assert.ok(dex.includes(Buffer.from(RPC)), 'RPC path');
  assert.ok(dex.includes(Buffer.from('/local/audio/speech')), 'Host path');
  assert.ok(dex.includes(Buffer.from('normalizeTextToSpeechBody')), 'body normalizer');
});

test('GatewayEndpointRouter.rewriteRpcPath sends TextToSpeech to /local/audio/speech (JVM)', (t) => {
  const sdkRoot = [process.env.ANDROID_HOME, path.join(os.homedir(), 'Library/Android/sdk'), '/Users/lianqishi/Library/Android/sdk']
    .find(dir => dir && fs.existsSync(path.join(dir, 'platforms/android-36/android.jar')));
  const javac = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  if (!sdkRoot || !javac) return t.skip('Android SDK (android-36) and a JDK are required');
  const java = javac.endsWith('javac') ? javac.slice(0, -1) : 'java';
  const androidJar = path.join(sdkRoot, 'platforms/android-36/android.jar');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-tts-rpc-'));
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
  const harness = path.join(tmp, 'TextToSpeechRpcHarness.java');
  fs.writeFileSync(harness, `
import dev.rokbot.nativeapp.GatewayEndpointRouter;
public class TextToSpeechRpcHarness {
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }
  public static void main(String[] args) {
    check("/local/audio/speech".equals(GatewayEndpointRouter.rewriteRpcPath("${RPC}")), "TextToSpeech");
    check("/local/audio/transcriptions".equals(GatewayEndpointRouter.rewriteRpcPath("/aiserver.v1.AiService/TranscribeAudio")), "TranscribeAudio unchanged");
    check("/local/voice/session".equals(GatewayEndpointRouter.rewriteRpcPath("/aiserver.v1.GrokBotService/MintSandVoiceCallSecret")), "voice mint unchanged");
    check("${RPC}/x".equals(GatewayEndpointRouter.rewriteRpcPath("${RPC}/x")), "exact path");
    check(GatewayEndpointRouter.normalizeTextToSpeechBody(null) == null, "missing body");
    System.out.println("TTS_RPC_OK");
  }
}
`);
  const classes = path.join(tmp, 'classes');
  fs.mkdirSync(classes);
  cp.execFileSync(javac, ['--release', '17', '-encoding', 'UTF-8', '-nowarn', '-cp', androidJar, '-d', classes, ...files, harness], { stdio: 'pipe' });
  const out = cp.execFileSync(java, ['-cp', `${classes}:${androidJar}`, 'TextToSpeechRpcHarness'], { encoding: 'utf8' });
  assert.match(out, /TTS_RPC_OK/);
});
