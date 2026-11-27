// RokBot Android in-app update: manifest registration, Host channel contract, AppUpdater policy
// and the RN SettingsSheet entry points.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ANDROID_NS, parseAxml, patchManifest } from '../patchers/manifest.mjs';
import { entryBytes, readZip } from '../patchers/signing.mjs';
import { runPatchPipeline } from '../release/patch-android.mjs';
import { UpdatesManager, ANDROID_UPDATE_SCHEMA, inspectApkBuffer } from '../../host/server/updates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_ROOT = path.resolve(__dirname, '..');
const FIXTURE_APK = path.join(NATIVE_ROOT, 'bin/rokbot-native-base.apk');
const SRC = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

test('Update manifest patch: registers UpdateActivity, the APK FileProvider and REQUEST_INSTALL_PACKAGES', () => {
  const zip = readZip(fs.readFileSync(FIXTURE_APK));
  const axml = entryBytes(zip.entries.find(e => e.name === 'AndroidManifest.xml'));
  const patched = patchManifest(axml, { packageName: 'dev.rokbot.local', versionCode: 321201, versionName: '1.26.0-rokbot.1' });
  const root = parseAxml(patched).rootNodes.find(n => n.name === 'manifest');
  const app = root.children.find(n => n.name === 'application');
  const attr = (node, name) => node.attributes.find(a => a.name === name && a.namespace === ANDROID_NS)?.value;
  const updateActivity = app.children.find(c => c.name === 'activity' && attr(c, 'name') === 'dev.rokbot.nativeapp.UpdateActivity');
  assert.ok(updateActivity, 'UpdateActivity must be registered');
  assert.equal(attr(updateActivity, 'exported'), false);
  const provider = app.children.find(c => c.name === 'provider' && attr(c, 'name') === 'dev.rokbot.nativeapp.ApkUpdateProvider');
  assert.equal(attr(provider, 'authorities'), 'dev.rokbot.local.rokbot.updateprovider');
  assert.equal(attr(provider, 'grantUriPermissions'), true);
  assert.ok(root.children.some(c => c.name === 'uses-permission' && attr(c, 'name') === 'android.permission.REQUEST_INSTALL_PACKAGES'));
});

test('Update channel: patched builds publish through the real Host UpdatesManager and match what UpdateManager reads', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-app-update-'));
  try {
    const keystore = path.join(tmp, 'signing.json');
    const apk1 = path.join(tmp, 'out1', 'RokBot-1.27.0-rokbot.1.apk');
    const apk2 = path.join(tmp, 'out2', 'RokBot-1.27.0-rokbot.2.apk');
    const r1 = await runPatchPipeline({ inputApk: FIXTURE_APK, outputApk: apk1, keystore, devSigning: true, rokbotBuild: 1, force: true });
    const r2 = await runPatchPipeline({ inputApk: FIXTURE_APK, outputApk: apk2, keystore, devSigning: true, rokbotBuild: 2, force: true });
    assert.equal(r1.versionCode, 328301);
    assert.equal(r1.versionName, '1.27.0-rokbot.1');
    assert.equal(r1.upstreamVersionCode, 3283);
    assert.equal(r1.devSigning, true);
    assert.equal(r2.versionCode, 328302);
    assert.equal(r2.signingCertificateSha256, r1.signingCertificateSha256);

    const info1 = inspectApkBuffer(fs.readFileSync(apk1));
    const info2 = inspectApkBuffer(fs.readFileSync(apk2));
    assert.equal(info2.packageName, 'dev.rokbot.local');
    assert.equal(info2.versionCode, 328302);
    assert.match(info2.certificateSha256, /^[0-9a-f]{64}$/);
    assert.equal(info1.certificateSha256, info2.certificateSha256, 'same signing identity => same certificate');

    const updates = await new UpdatesManager(tmp, { updateDir: path.join(tmp, 'updates') }).load();
    assert.throws(() => updates.manifestFor('android.json', 'http://host'), err => err.status === 404,
      'empty channel answers 404, which AppUpdater treats as "up to date, nothing published"');

    fs.copyFileSync(apk2, path.join(updates.artifactsDir, 'android', path.basename(apk2)));
    await updates.publish({ platform: 'android', filename: path.basename(apk2), releaseNotes: '修复与改进' }, 'http://host');
    const m = updates.manifestFor('android.json', 'http://host');
    // Fields UpdateManager.fetchAndParseManifest relies on.
    assert.equal(m.schema, ANDROID_UPDATE_SCHEMA);
    assert.equal(m.latest.packageName, 'dev.rokbot.local');
    assert.equal(m.latest.versionName, '1.27.0-rokbot.2');
    assert.equal(m.latest.versionCode, 328302, 'versionCode comes from the APK itself');
    assert.equal(m.latest.certificateSha256, info1.certificateSha256, 'certificate pinned to the installed signer');
    assert.equal(m.latest.apkSize, fs.statSync(apk2).size);
    assert.match(m.latest.apkSha256, /^[0-9a-f]{64}$/);
    assert.equal(m.latest.apkUrl, 'http://host/local/updates/files/android/RokBot-1.27.0-rokbot.2.apk');
    assert.equal(m.latest.releaseNotes, '修复与改进');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Update wiring: auto-check trigger, verified hand-off to the installer and SettingsSheet entry points', () => {
  const boot = read('RokBotBootstrap.java');
  assert.match(boot, /if \(prevCount == 0 && nowCount > 0\) \{[\s\S]*?AppUpdater\.onAppForeground\(activity\);[\s\S]*?\}/,
    'cold start and every return to the foreground ask AppUpdater (which throttles)');
  assert.match(boot, /isUpdateEntryLabel\(label\) \|\| \(view instanceof TextView && isVersionLine\(/);
  assert.match(boot, /return view\.getWidth\(\) > 0 && view\.getHeight\(\) > 0 \? UpdateActivity\.class : null;/);
  assert.match(boot, /applyVersionLine\(activity, \(TextView\) view, label\.trim\(\)\);/);

  const um = read('UpdateManager.java');
  assert.match(um, /if \(!certSha\.isEmpty\(\) && !certSha\.equalsIgnoreCase\(installedCert\)\)/, 'manifest certificate is checked before download');
  assert.match(um, /stagedCert == null \|\| !stagedCert\.equalsIgnoreCase\(expectedCertSha256\)/, 'downloaded APK certificate is checked');
  assert.match(um, /stagedVersionCode < installedVersionCode/, 'downgrades are refused before the installer');
  assert.match(um, /!sha256Hex\(tmpApk\)\.equalsIgnoreCase\(info\.targetSha256\)/, 'SHA-256 is verified');
  assert.match(um, /new File\(ctx\.getFilesDir\(\), "updates"\)/, 'downloads stay in app-private storage');
  assert.match(um, /ApkUpdateProvider\.uriFor\(context, apkFile\)/);
  assert.match(um, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(um, /Settings\.ACTION_MANAGE_UNKNOWN_APP_SOURCES/);

  const ua = read('UpdateActivity.java');
  assert.match(ua, /if \(!UpdateManager\.canInstallPackages\(this\)\) \{/, 'asks for "install unknown apps" before the installer');
  assert.match(ua, /mInstallAfterPermission = true;/);
  assert.match(ua, /AppUpdater\.notePendingInstall\(this\);\s*UpdateManager\.launchInstaller\(this, apk\);/);

  const au = read('AppUpdater.java');
  assert.match(au, /UpdateManager\.isNewerVersionCode\(installed, info\.availableVersionCode\)/, 'offers strictly higher versionCodes only');
  assert.match(au, /if \(automatic\) main\(\)\.post\(AppUpdater::promptOnForegroundActivity\);/, 'only automatic checks prompt');
  assert.match(au, /"立即更新"/);
  assert.match(au, /"稍后"/);

  // rokbot.5/6: "应用更新 / App Updates" (rokbot.5: "检查更新 / Software Update") is a first-level
  // settings row (hermes-settings.mjs applySettingsMenu) routed to UpdateActivity; the connection
  // page has no update flow of its own.
  assert.match(boot, /matchesSoftwareUpdateLabel\(s\)\) \{\s*return \(paired && isInteractiveTarget[^;]*\? UpdateActivity\.class/, 'settings row "应用更新" opens UpdateActivity');
  // 「检查更新」 with no update must stay on UpdateActivity: our own pages are never re-wired by the
  // RN click hook (that rewired the 检查更新 pill to launch a second UpdateActivity on every
  // AppUpdater state change), and a native page never launches itself.
  assert.match(boot, /target != null && shouldWireNativeHook\(activity\.getClass\(\)\.getName\(\), target\)/,
    'scanAndWireRnViews skips companion pages and self-targets');
  assert.match(boot, /if \(!shouldLaunchNativeTarget\(activity\.getClass\(\)\.getName\(\), dest\)\) return;/);
  assert.match(boot, /FLAG_ACTIVITY_SINGLE_TOP/);
  assert.match(ua, /mManualCheckPending = true;\s*AppUpdater\.check\(this, false\);/, 'manual check runs in place');
  assert.match(ua, /shouldToastUpToDate\(mManualCheckPending, st\)[\s\S]*?"已是最新版本"/, 'up-to-date result is a toast on the same page');
  assert.doesNotMatch(ua, /startActivity\(new Intent\(this, UpdateActivity\.class\)/, 'UpdateActivity never starts itself');
  const pairing = read('PairingActivity.java');
  assert.doesNotMatch(pairing, /runUpdateCheck|UpdateManager\.stageFromInfoAsync/, 'PairingActivity does not repeat the update flow');
});

test('Update policy (JVM): 6 h throttle, versionCode comparison, version line and entry labels', () => {
  const sdkRoot = [process.env.ANDROID_HOME, '/Users/lianqishi/Library/Android/sdk', '/Volumes/ORICO/android/sdk']
    .find(d => d && fs.existsSync(path.join(d, 'platforms/android-36/android.jar')));
  const javacBin = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  assert.ok(sdkRoot && javacBin, 'Android SDK and JDK required for JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const androidJar = path.join(sdkRoot, 'platforms/android-36/android.jar');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-app-update-jvm-'));
  try {
    const out = path.join(tmp, 'classes');
    fs.mkdirSync(out, { recursive: true });
    const files = [];
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.java')) files.push(full);
      }
    };
    walk(path.join(NATIVE_ROOT, 'companion/compile-stubs/src/main/java'));
    walk(path.join(NATIVE_ROOT, 'companion/src/main/java'));
    const harnessDir = path.join(tmp, 'src/dev/rokbot/nativeapp');
    fs.mkdirSync(harnessDir, { recursive: true });
    const harness = path.join(harnessDir, 'AppUpdatePolicyHarness.java');
    fs.writeFileSync(harness, `package dev.rokbot.nativeapp;

public class AppUpdatePolicyHarness {
    static void check(boolean c, String m) { if (!c) throw new AssertionError(m); }
    public static void main(String[] a) {
        long H = 60L * 60L * 1000L, M = 60L * 1000L, now = 1_800_000_000_000L;
        check(AppUpdater.AUTO_CHECK_INTERVAL_MS == 6 * H, "6 h interval");
        check(AppUpdater.shouldAutoCheck(now, 0, 0), "never checked -> check");
        check(!AppUpdater.shouldAutoCheck(now, now - 5 * H, now - 5 * H), "5 h after success -> skip");
        check(!AppUpdater.shouldAutoCheck(now, now - 6 * H + 1, now - 6 * H + 1), "just under 6 h -> skip");
        check(AppUpdater.shouldAutoCheck(now, now - 6 * H, now - 6 * H), "6 h after success -> check");
        check(!AppUpdater.shouldAutoCheck(now, now - 7 * H, now - 10 * M), "failed 10 min ago -> wait");
        check(AppUpdater.shouldAutoCheck(now, now - 7 * H, now - 31 * M), "failed 31 min ago -> retry");
        check(!AppUpdater.shouldAutoCheck(now, 0, now - 5 * M), "offline first launch retries after 30 min");
        check(AppUpdater.shouldAutoCheck(now, now + 2 * H, now + 2 * H), "clock moved backwards -> check");

        check(UpdateManager.isNewerVersionCode(321201, 321202), "higher versionCode is an update");
        check(UpdateManager.isNewerVersionCode(3212, 321201), "first RokBot build upgrades the official 3212");
        check(!UpdateManager.isNewerVersionCode(321202, 321202), "same versionCode is not an update");
        check(!UpdateManager.isNewerVersionCode(321202, 321201), "lower versionCode is not an update");
        check(!UpdateManager.isNewerVersionCode(321202, -1), "missing versionCode is not an update");

        check("1.26.0-rokbot.2 (321202)".equals(AppUpdater.formatVersion("1.26.0-rokbot.2", 321202)), "formatVersion");
        check("1.26.0".equals(AppUpdater.formatVersion("1.26.0", 0)), "formatVersion without code");
        String base = RokBotBootstrap.rnVersionLine("1.26.0-rokbot.1", 321201);
        check("1.26.0-rokbot.1 (321201)".equals(base), "expo-application line: " + base);
        check(RokBotBootstrap.rnVersionLine("", 3212) == null && RokBotBootstrap.rnVersionLine("1.26.0", 0) == null, "no line without name/code");
        String[] zh = AppUpdater.versionLineCandidates(base, "1.26.0-rokbot.1", AppUpdater.STATE_UP_TO_DATE, true);
        check(zh[0].equals("1.26.0-rokbot.1 (321201) · 已是最新版本"), zh[0]);
        check(zh[zh.length - 1].equals("1.26.0-rokbot.1 · 最新"), zh[zh.length - 1]);
        String[] av = AppUpdater.versionLineCandidates(base, "1.26.0-rokbot.1", AppUpdater.STATE_AVAILABLE, true);
        check(av[0].equals("1.26.0-rokbot.1 (321201) · 有新版本"), av[0]);
        check(AppUpdater.versionLineCandidates(base, "1.26.0-rokbot.1", AppUpdater.STATE_READY, false)[0].endsWith(" · Update available"), "en ready");
        check(AppUpdater.versionLineCandidates(base, "x", AppUpdater.STATE_CHECKING, true).length == 1, "checking keeps the bare line");

        check(RokBotBootstrap.isUpdateEntryLabel("Update to latest version"), "official en entry");
        check(RokBotBootstrap.isUpdateEntryLabel(" 更新到最新版本 "), "official zh entry");
        check(!RokBotBootstrap.isUpdateEntryLabel("Updates"), "unrelated label");
        String self = "dev.rokbot.nativeapp.UpdateActivity";
        check(!RokBotBootstrap.shouldWireNativeHook(self, UpdateActivity.class), "UpdateActivity's own 检查更新 pill is not rewired");
        check(!RokBotBootstrap.shouldWireNativeHook("dev.rokbot.nativeapp.ProfileActivity", UpdateActivity.class), "companion pages keep their own listeners");
        check(RokBotBootstrap.shouldWireNativeHook("expo.modules.SomeSheetActivity", UpdateActivity.class), "third-party surfaces still route 应用更新");
        check(!RokBotBootstrap.shouldWireNativeHook("x.Y", null), "no target -> no hook");
        check(!RokBotBootstrap.shouldLaunchNativeTarget(self, UpdateActivity.class), "never stack UpdateActivity on itself");
        check(RokBotBootstrap.shouldLaunchNativeTarget("com.grok.MainActivity", UpdateActivity.class), "RN settings row opens UpdateActivity");
        check(UpdateActivity.shouldToastUpToDate(true, AppUpdater.STATE_UP_TO_DATE), "manual check, nothing new -> 已是最新版本 toast");
        check(!UpdateActivity.shouldToastUpToDate(false, AppUpdater.STATE_UP_TO_DATE), "automatic check stays silent");
        check(!UpdateActivity.shouldToastUpToDate(true, AppUpdater.STATE_AVAILABLE), "update available -> no up-to-date toast");
        check(RokBotBootstrap.isStrictlyInside(0, 0, 100, 50, 10f, 10f), "point on a top button is occluded");
        check(!RokBotBootstrap.isStrictlyInside(0, 0, 100, 50, 100f, 10f), "right edge is outside");
        check(!RokBotBootstrap.isStrictlyInside(0, 0, 0, 0, 0f, 0f), "empty view never occludes");
        System.out.println("APP_UPDATE_POLICY_OK");
    }
}
`);
    cp.execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-cp', androidJar, '-d', out, ...files, harness], { stdio: 'pipe' });
    const res = cp.execFileSync(javaBin, ['-cp', `${out}:${androidJar}`, 'dev.rokbot.nativeapp.AppUpdatePolicyHarness'], { encoding: 'utf8' });
    assert.ok(res.includes('APP_UPDATE_POLICY_OK'), res);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
