#!/usr/bin/env node
// Standalone Native Android Client Patcher CLI for RokBot (official ai.x.grok.bot 1.26.0).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { parseAxml, serializeAxml, patchManifest, extractManifestInfo, resolveRokbotVersion, ANDROID_NS, KNOWN_RES_IDS } from '../patchers/manifest.mjs';
import { addFileResourceDensity, findMipmapResourceId, findResourceId, setColorResourceValue } from '../patchers/arsc.mjs';
import {
  dexEntriesContainClass,
  injectCompanionDex,
  neutralizePairipAndHookOkHttp,
  injectTailcatLibs,
  loadDefaultCompanionDex,
} from '../patchers/dex.mjs';
import { neutralizePairipElfs } from '../patchers/pairip-elf.mjs';
import { normalizeApkOrXapk } from '../patchers/xapk.mjs';
import { patchHermesBundleSafely, suppressExpoUpdates } from '../patchers/hermes.mjs';
import {
  readZip,
  entryBytes,
  createEntry,
  writeZip,
  signApk,
} from '../patchers/signing.mjs';
import {
  RELEASE_CERTIFICATE_SHA256,
  SIGNING_PIN_PATH,
  loadSigningPin,
  resolveReleaseSigningIdentity,
  assertSignedApkCertificate,
} from './signing-guard.mjs';

export { RELEASE_CERTIFICATE_SHA256, SIGNING_PIN_PATH, loadSigningPin };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const REPO_ANDROID_DIR = path.resolve(ROOT_DIR, 'android');
const RECIPES_DIR = path.resolve(__dirname, '../recipes');
const LOGO_ANDROID_DIR = path.resolve(ROOT_DIR, 'assets/logo/android');
const ICON_DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
// Adaptive icon background layer (@color/iconBackground, official #ff000000): the light mid-point of
// the RokBot tile gradient, so the launcher mask shows the white-tile logo around the head foreground.
// Must match androidIconBackground in assets/logo/manifest.json (assets/logo/generate_icons.py).
export const ANDROID_ICON_BACKGROUND_ARGB = 0xffdff4fa;
const ICON_KINDS = ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground'];
const MIPMAP_ICON_RE = /^res\/mipmap-(mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)(?:-v\d+)?\/(ic_launcher(?:_round|_foreground)?)\.(?:png|webp)$/i;
const ADAPTIVE_ICON_XML_RE = /^res\/mipmap-anydpi(?:-v\d+)?\/ic_launcher(?:_round)?\.xml$/i;
const SPLASH_DRAWABLE_RE = /^res\/drawable(?:-(mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi|nodpi))?(?:-v\d+)?\/(splashscreen_logo|bootsplash_logo|splash_logo|ic_splash|splash_icon)\.(?:png|webp)$/i;
// The Android 12+ system splash icon (Theme.App.SplashScreen windowSplashScreenAnimatedIcon), light
// and night. The official 1.26.0 XAPK only ships it as a 108 px mdpi bitmap (config.mdpi split), which
// Android stretched to the 288 dp splash box: the blurry first logo before React Native's own sharp
// launch-mark. It becomes assets/logo/android/splash/splashscreen_logo-<density>.webp: the
// launch-mark's 64 dp tile centered in the 288 dp box (both stages are the same picture), as a
// two-frame animated WebP that the system splash draws live instead of through its low-resolution
// icon cache (see assets/logo/generate_icons.py). resources.arsc gets xxxhdpi twins of the mdpi
// configurations (denser screens scale a 1152 px image down) and every splash path ends in .webp.
const SYSTEM_SPLASH_RE = /^res\/drawable(?:-night)?-(mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi|nodpi)(?:-v\d+)?\/splashscreen_logo\.(?:png|webp)$/i;
const SPLASH_DENSITY_FILES = { mdpi: 'splashscreen_logo-mdpi.webp', xxxhdpi: 'splashscreen_logo-xxxhdpi.webp' };
// React Native's own app icon asset (assets/appIcon/assets/dark.svg), shown in-app (notification prompt).
const RN_APP_ICON_RE = /^res\/raw\/assets_appicon_[a-z0-9_]+\.svg$/i;
const LOGO_SVG_PATH = path.resolve(ROOT_DIR, 'assets/logo/rokbot-app-icon.svg');
const NOTIF_DRAWABLE_RE = /^res\/drawable(?:-(mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi|nodpi))?(?:-v\d+)?\/(notification_icon|ic_notification|ic_stat_onesignal_default)\.(?:png|webp)$/i;
function getDrawableAttr(node) {
  return (node.attributes || []).find(
    a => a.resourceId === KNOWN_RES_IDS.drawable || (a.name === 'drawable' && a.namespace === ANDROID_NS)
  );
}

function setAdaptiveDrawableAttr(node, type, data) {
  node.attributes = node.attributes || [];
  let attr = node.attributes.find(
    a => a.resourceId === KNOWN_RES_IDS.drawable || (a.name === 'drawable' && a.namespace === ANDROID_NS)
  );
  if (!attr) {
    attr = {
      name: 'drawable',
      namespace: ANDROID_NS,
      resourceId: KNOWN_RES_IDS.drawable,
      type,
      rawValue: null,
      value: data >>> 0,
      data: data >>> 0,
    };
    node.attributes.push(attr);
  } else {
    attr.resourceId = KNOWN_RES_IDS.drawable;
    attr.type = type;
    attr.rawValue = null;
    attr.value = data >>> 0;
    attr.data = data >>> 0;
  }
}

export function patchLauncherIcons(entries, logoDir = LOGO_ANDROID_DIR) {
  if (!logoDir || !fs.existsSync(logoDir)) {
    return { entries, replaced: 0, inserted: 0, adaptiveIconsPatched: 0, brandDrawablesReplaced: 0, iconBackgroundPatched: 0 };
  }
  const iconMap = new Map();
  for (const density of ICON_DENSITIES) {
    for (const kind of ICON_KINDS) {
      const iconPath = path.join(logoDir, `mipmap-${density}`, `${kind}.png`);
      if (fs.existsSync(iconPath)) {
        iconMap.set(`${density}:${kind}`, fs.readFileSync(iconPath));
      }
    }
  }
  if (iconMap.size === 0) {
    return { entries, replaced: 0, inserted: 0, adaptiveIconsPatched: 0, brandDrawablesReplaced: 0, iconBackgroundPatched: 0 };
  }

  const pickDensityAsset = (rawDensity, preferredKind = 'ic_launcher_foreground') => {
    const d = (rawDensity || '').toLowerCase();
    const density = ICON_DENSITIES.includes(d) ? d : 'xxhdpi';
    return (
      iconMap.get(`${density}:${preferredKind}`)
      || iconMap.get(`${density}:ic_launcher`)
      || iconMap.get(`xxhdpi:${preferredKind}`)
      || iconMap.get('xxhdpi:ic_launcher')
      || null
    );
  };

  const splashDir = path.join(logoDir, 'splash');
  const splashAssets = Object.values(SPLASH_DENSITY_FILES).every(f => fs.existsSync(path.join(splashDir, f)))
    ? Object.fromEntries(Object.entries(SPLASH_DENSITY_FILES).map(([d, f]) => [d, fs.readFileSync(path.join(splashDir, f))]))
    : null;

  const arscEntry = entries.find(e => e.name === 'resources.arsc');
  const fgMipmapId = arscEntry ? findMipmapResourceId(entryBytes(arscEntry), 'ic_launcher_foreground') : null;

  const matchedKeys = new Set();
  let replaced = 0;
  let adaptiveIconsPatched = 0;
  let brandDrawablesReplaced = 0;
  const updated = entries.map(entry => {
    if (ADAPTIVE_ICON_XML_RE.test(entry.name)) {
      try {
        const ast = parseAxml(entryBytes(entry));
        const root = (ast.rootNodes || []).find(n => n.name === 'adaptive-icon');
        if (root) {
          root.children = (root.children || []).filter(c => c.name !== 'monochrome');
          // Keep the original <background> resource reference (official @color/iconBackground); its value is
          // recolored to ANDROID_ICON_BACKGROUND_ARGB in resources.arsc below.
          // Live emulator verification (Android 17 / Pixel Launcher) showed that rewriting it to an inline
          // TYPE_INT_COLOR_ARGB8 literal makes the launcher reject the adaptive icon and fall back to the
          // generic system icon, even though Settings > App info still renders it.
          const bgNode = root.children.find(c => c.name === 'background');
          if (bgNode && !getDrawableAttr(bgNode)) {
            const bgColorId = arscEntry ? findResourceId(entryBytes(arscEntry), 'color', 'iconBackground') : null;
            if (bgColorId != null) setAdaptiveDrawableAttr(bgNode, 0x01, bgColorId);
          }
          if (fgMipmapId != null) {
            const fgNode = root.children.find(c => c.name === 'foreground');
            if (fgNode) {
              setAdaptiveDrawableAttr(fgNode, 0x01, fgMipmapId);
            }
          }
          const patchedXml = serializeAxml(ast);
          adaptiveIconsPatched++;
          return createEntry(entry.name, patchedXml, { store: false });
        }
      } catch {
        // Leave malformed XML untouched rather than crashing non-adaptive builds
      }
      return entry;
    }

    const systemSplash = SYSTEM_SPLASH_RE.exec(entry.name);
    if (systemSplash && splashAssets) {
      brandDrawablesReplaced++;
      return createEntry(entry.name, systemSplash[1].toLowerCase() === 'mdpi' ? splashAssets.mdpi : splashAssets.xxxhdpi, { store: false });
    }

    const splashMatch = SPLASH_DRAWABLE_RE.exec(entry.name);
    if (splashMatch) {
      const pngBuf = pickDensityAsset(splashMatch[1], 'ic_launcher_foreground');
      if (pngBuf) {
        brandDrawablesReplaced++;
        return createEntry(entry.name, pngBuf, { store: false });
      }
    }

    if (RN_APP_ICON_RE.test(entry.name) && fs.existsSync(LOGO_SVG_PATH)) {
      brandDrawablesReplaced++;
      return createEntry(entry.name, fs.readFileSync(LOGO_SVG_PATH), { store: false });
    }

    const notifMatch = NOTIF_DRAWABLE_RE.exec(entry.name);
    if (notifMatch) {
      const pngBuf = pickDensityAsset(notifMatch[1], 'ic_launcher_foreground');
      if (pngBuf) {
        brandDrawablesReplaced++;
        return createEntry(entry.name, pngBuf, { store: false });
      }
    }

    const m = MIPMAP_ICON_RE.exec(entry.name);
    if (!m) return entry;
    const key = `${m[1].toLowerCase()}:${m[2].toLowerCase()}`;
    const pngBuf = iconMap.get(key);
    if (!pngBuf) return entry;
    matchedKeys.add(key);
    replaced++;
    return createEntry(entry.name, pngBuf, { store: false });
  });

  let inserted = 0;
  for (const [key, pngBuf] of iconMap.entries()) {
    if (matchedKeys.has(key)) continue;
    const [density, kind] = key.split(':');
    updated.push(createEntry(`res/mipmap-${density}/${kind}.png`, pngBuf, { store: false }));
    inserted++;
  }

  // Recolor the adaptive background layer in place (same table size; resources.arsc stays stored).
  let iconBackgroundPatched = 0;
  const arscIndex = updated.findIndex(e => e.name === 'resources.arsc');
  if (arscIndex >= 0 && adaptiveIconsPatched > 0) {
    const recolored = setColorResourceValue(entryBytes(updated[arscIndex]), 'iconBackground', ANDROID_ICON_BACKGROUND_ARGB);
    if (recolored.patched > 0) {
      iconBackgroundPatched = recolored.patched;
      updated[arscIndex] = createEntry('resources.arsc', recolored.buffer, { store: true });
    }
  }

  // System splash icon: xxxhdpi twins of its mdpi configurations (light and night) and .webp paths,
  // see SYSTEM_SPLASH_RE.
  const splashDensitiesAdded = [];
  let result = updated;
  const tableIndex = result.findIndex(e => e.name === 'resources.arsc');
  if (splashAssets && tableIndex >= 0) {
    const withSplash = addFileResourceDensity(entryBytes(result[tableIndex]), 'drawable', 'splashscreen_logo',
      { fromDensity: 160, density: 640, fromQualifier: 'mdpi', qualifier: 'xxxhdpi', extension: '.webp' });
    if (withSplash.added.length) {
      result = result.slice();
      result[tableIndex] = createEntry('resources.arsc', withSplash.buffer, { store: true });
      const renamedFrom = new Set(withSplash.renamed.map(r => r.from));
      result = result.filter(e => !renamedFrom.has(e.name));
      for (const { path: file } of withSplash.renamed) {
        if (!result.some(e => e.name === file)) result.push(createEntry(file, splashAssets.mdpi, { store: false }));
      }
      for (const { path: file } of withSplash.added) {
        if (!result.some(e => e.name === file)) result.push(createEntry(file, splashAssets.xxxhdpi, { store: false }));
        splashDensitiesAdded.push(file);
      }
    }
  }

  return { entries: result, replaced, inserted, adaptiveIconsPatched, brandDrawablesReplaced, iconBackgroundPatched, splashDensitiesAdded };
}

const PAIRING_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/i;
const PACKAGE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function parseCliArgs(args = process.argv.slice(2)) {
  const options = {
    inputApk: null,
    outputApk: null,
    host: null,
    pairingCode: null,
    packageName: null,
    keystore: null,
    devSigning: undefined,
    standalone: false,
    windowsSetup: null,
    shellApk: null,
    unsigned: false,
    verifyOnly: false,
    force: false,
    forceHbc: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input-apk' || arg === '--input' || arg === '--apk') {
      options.inputApk = args[++i];
    } else if (arg === '--output-apk' || arg === '--output') {
      options.outputApk = args[++i];
    } else if (arg === '--host') {
      options.host = args[++i];
    } else if (arg === '--pairing-code' || arg === '--pairing-key') {
      options.pairingCode = args[++i];
    } else if (arg === '--package-name' || arg === '--bundle-id') {
      options.packageName = args[++i];
    } else if (arg === '--update-url') {
      options.updateUrl = args[++i];
    } else if (arg === '--rokbot-build') {
      options.rokbotBuild = args[++i];
    } else if (arg === '--version-code') {
      options.versionCode = args[++i];
    } else if (arg === '--version-name') {
      options.versionName = args[++i];
    } else if (arg === '--keystore') {
      options.keystore = args[++i];
    } else if (arg === '--dev-signing') {
      options.devSigning = true;
    } else if (arg === '--standalone' || arg === '--standalone-official') {
      options.standalone = true;
    } else if (arg === '--windows-setup') {
      options.windowsSetup = args[++i];
    } else if (arg === '--shell-apk') {
      options.shellApk = args[++i];
    } else if (arg === '--unsigned') {
      options.unsigned = true;
    } else if (arg === '--verify-only') {
      options.verifyOnly = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--force-hbc') {
      options.forceHbc = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    }
  }

  return options;
}

export async function runPatchPipeline(options) {
  const started = Date.now();
  const manifestPath = path.join(RECIPES_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Pinned manifest not found at ${manifestPath}`);
  }
  const manifestPin = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (options.standalone) {
    throw new Error(
      '--standalone Windows WebView wrapper mode is removed. Supply an official Android .apk/.xapk/.apks via --input-apk.'
    );
  }

  // 1. Validate Arguments
  if (!options.inputApk) {
    throw new Error('Missing required argument: --input-apk');
  }
  if (!options.verifyOnly && !options.outputApk) {
    throw new Error('Missing required argument: --output-apk');
  }
  if (!fs.existsSync(options.inputApk)) {
    throw new Error(`Input APK file not found: ${options.inputApk}`);
  }
  if (options.packageName !== undefined && options.packageName !== null) {
    const cleanPkg = String(options.packageName).trim();
    if (!PACKAGE_NAME_RE.test(cleanPkg)) {
      throw new Error('--package-name / --bundle-id must be a valid Android applicationId (e.g. dev.rokbot.nativeapp)');
    }
    options.packageName = cleanPkg;
  }

  if (options.host) {
    const trimmedHost = String(options.host).trim();
    if (/^tailcat:/i.test(trimmedHost)) {
      if (!/^tailcat:\/\/connect\/tc[A-Za-z0-9_-]{30,16384}\?port=[1-9][0-9]{0,4}$/.test(trimmedHost)) {
        throw new Error('--host must be a valid tailcat://connect/<node>?port=<port> URL');
      }
      const portMatch = /\?port=(\d+)$/.exec(trimmedHost);
      const portNum = portMatch ? Number(portMatch[1]) : 0;
      if (portNum < 1 || portNum > 65535) {
        throw new Error('--host Tailcat port is out of range');
      }
    } else {
      let parsedUrl;
      try {
        parsedUrl = new URL(trimmedHost);
      } catch {
        throw new Error('--host must be a valid HTTP or HTTPS URL');
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('--host must be a valid HTTP or HTTPS URL');
      }
      if (parsedUrl.username || parsedUrl.password || trimmedHost.includes('@')) {
        throw new Error('--host must not contain user credentials');
      }
      if (!parsedUrl.hostname || parsedUrl.hostname.trim() === '') {
        throw new Error('--host must be a valid HTTP or HTTPS URL');
      }
    }
  }

  if (options.pairingCode !== undefined && options.pairingCode !== null) {
    const code = String(options.pairingCode).toUpperCase();
    if (!PAIRING_CODE_RE.test(code)) {
      throw new Error('--pairing-code must be exactly 6 uppercase alphanumeric characters excluding I/O/1/0');
    }
    options.pairingCode = code;
  }

  if (options.outputApk && fs.existsSync(options.outputApk) && !options.force && !options.verifyOnly) {
    throw new Error(`Output APK already exists at ${options.outputApk}. Use --force to overwrite.`);
  }

  // 2. Read and Validate Archive (Zip-Slip check)
  const inputBytes = fs.readFileSync(options.inputApk);
  const inputSha256 = sha256Buffer(inputBytes);
  const normalized = normalizeApkOrXapk(inputBytes, { abi: 'arm64-v8a' });
  const zip = {
    entries: normalized.entries,
    mergedSplits: normalized.mergedSplits,
    isSplitArchive: normalized.isSplitArchive,
  };

  if (zip.entries.length > 20000) {
    throw new Error('APK exceeds max entry limit (>20000)');
  }
  const totalUncompressed = zip.entries.reduce((acc, e) => acc + e.size, 0);
  if (totalUncompressed > 2 * 1024 * 1024 * 1024) {
    throw new Error('APK exceeds max uncompressed size (>2GB)');
  }

  for (const entry of zip.entries) {
    const name = entry.name;
    if (
      path.isAbsolute(name) ||
      name.startsWith('/') ||
      name.startsWith('\\') ||
      /^[A-Za-z]:/.test(name) ||
      name.includes('\0') ||
      name.includes('..')
    ) {
      throw new Error(`Zip-Slip security violation in APK entry: ${name}`);
    }
  }

  // 3. Verify Manifest & HBC Bundle Hashes
  const manifestEntry = zip.entries.find(e => e.name === 'AndroidManifest.xml');
  if (!manifestEntry) {
    throw new Error('Input APK does not contain AndroidManifest.xml');
  }
  const manifestBytes = entryBytes(manifestEntry);
  const axmlAst = parseAxml(manifestBytes);

  const manifestNode = axmlAst.rootNodes.find(n => n.name === 'manifest');
  let pkgName = null;
  if (manifestNode) {
    const pkgAttr = manifestNode.attributes.find(a => a.name === 'package');
    if (pkgAttr) pkgName = String(pkgAttr.value);
  }

  const bundleEntry = zip.entries.find(e => e.name === 'assets/index.android.bundle');
  let hbcSha256 = null;
  if (bundleEntry) {
    hbcSha256 = sha256Buffer(entryBytes(bundleEntry));
  }

  // Detect Google Play Pairip anti-tamper protection (neutralized cleanly during patch phase).
  const pairipMarkers = [];
  if (inputBytes.includes(Buffer.from('libpairipcore.so')) || zip.entries.some(e => /(^|\/)libpairipcore\.so$/i.test(e.name))) {
    pairipMarkers.push('libpairipcore.so');
  }
  if (dexEntriesContainClass(zip.entries, 'Lcom/pairip/SignatureCheck;')) {
    pairipMarkers.push('com.pairip.SignatureCheck');
  }
  if (dexEntriesContainClass(zip.entries, 'Lcom/pairip/VMRunner;')) {
    pairipMarkers.push('com.pairip.VMRunner');
  }
  if (dexEntriesContainClass(zip.entries, 'Lcom/pairip/application/Application;')) {
    pairipMarkers.push('com.pairip.application.Application');
  }
  if (dexEntriesContainClass(zip.entries, 'Lcom/pairip/licensecheck/LicenseClient;')) {
    pairipMarkers.push('com.pairip.licensecheck.LicenseClient');
  }

  if (options.verifyOnly) {
    return {
      verified: true,
      packageName: pkgName,
      inputSha256,
      hbcSha256,
      entryCount: zip.entries.length,
      isSplitArchive: zip.isSplitArchive,
      mergedSplits: zip.mergedSplits,
      pairipDetected: pairipMarkers.length > 0,
      pairipMarkers,
      targetPinnedPackage: manifestPin.packageName,
      targetPinnedVersion: manifestPin.version,
    };
  }

  const manifestInfo = extractManifestInfo(manifestBytes);

  // 4. Patch AXML Manifest
  const hasAiXGrokBotApp = dexEntriesContainClass(zip.entries, 'Lai/x/grok/bot/MainApplication;');
  const hasSandApp = dexEntriesContainClass(zip.entries, 'Lco/anysphere/sand/MainApplication;');
  const hasMainApplication = hasAiXGrokBotApp || hasSandApp;
  const setApplicationName = Boolean(options.setApplicationName ?? hasMainApplication);
  const inferredApplicationName = hasSandApp && !hasAiXGrokBotApp
    ? 'dev.rokbot.nativeapp.RokBotSandApplication'
    : 'dev.rokbot.nativeapp.RokBotApplication';
  const targetPackageName = options.packageName
    || ((manifestInfo.packageName === 'ai.x.grok.bot' || manifestInfo.packageName === 'co.anysphere.sand')
      ? 'dev.rokbot.local'
      : manifestInfo.packageName);
  const outputVersion = resolveRokbotVersion(manifestInfo, options);
  const patchedManifestBytes = patchManifest(manifestBytes, {
    packageName: targetPackageName,
    versionCode: outputVersion.versionCode,
    versionName: outputVersion.versionName,
    permissions: manifestPin.permissions,
    pairingActivity: manifestPin.components?.activities?.[0]?.name,
    notificationService: manifestPin.components?.services?.[0]?.name,
    setApplicationName,
    applicationName: options.applicationName || inferredApplicationName,
  });

  // 5. Strip legacy v1 JAR signatures, keep resources.arsc uncompressed, update AndroidManifest.xml
  const isLegacyV1Sig = name => /^META-INF\/(?:MANIFEST\.MF|.*\.(?:SF|RSA|DSA|EC))$/i.test(name);
  let patchedEntries = zip.entries
    .filter(entry => !isLegacyV1Sig(entry.name))
    .map(entry => {
      if (entry.name === 'AndroidManifest.xml') {
        return createEntry('AndroidManifest.xml', patchedManifestBytes, { store: true });
      }
      if (entry.name === 'resources.arsc' && entry.method !== 0) {
        return createEntry('resources.arsc', entryBytes(entry), { store: true });
      }
      return entry;
    });

  // 6. Neutralize Google Play Pairip DEX & ELF Checks, Hook R8 OkHttp Factory, Inject Companion Dex & Tailcat Libs
  const dexPatchResult = neutralizePairipAndHookOkHttp(patchedEntries);
  const elfPatchResult = neutralizePairipElfs(patchedEntries, {
    recipesDir: RECIPES_DIR,
    versionCode: manifestInfo.versionCode,
  });

  const companionDexBytes = loadDefaultCompanionDex();
  const dexResult = injectCompanionDex(patchedEntries, companionDexBytes);
  patchedEntries = dexResult.entries;

  const tailcatResult = injectTailcatLibs(patchedEntries);
  patchedEntries = tailcatResult.entries;

  // 7. Patch Hermes Bytecode Bundle (safely), apply .gbp.gz bytepatch recipes when pinned, & Disable Expo Updates
  let bundlePatched = false;
  let bytepatchApplied = false;
  let bundlePatchMode = 'no-bundle';
  let hbcPinMatched = null;
  let unpairedHbc = null;
  let gatewayTemplateHbc = null;
  let gatewayTemplateJson = null;
  let settingsRebrand = null;
  patchedEntries = patchedEntries.map(entry => {
    if (entry.name === 'assets/index.android.bundle') {
      const origBundle = entryBytes(entry);
      const res = patchHermesBundleSafely(origBundle, {
        host: options.host,
        pairingCode: options.pairingCode,
        recipesDir: RECIPES_DIR,
        versionCode: manifestInfo.versionCode,
        force: Boolean(options.forceHbc),
      });
      bundlePatched = res.patched;
      bytepatchApplied = Boolean(res.bytepatchApplied);
      bundlePatchMode = res.mode;
      hbcPinMatched = res.pinMatched;
      unpairedHbc = res.unpairedHbc || null;
      gatewayTemplateHbc = res.gatewayTemplateHbc || null;
      gatewayTemplateJson = res.gatewayTemplateJson || null;
      settingsRebrand = res.settingsRebrand || null;
      return createEntry(entry.name, res.buffer, { store: false });
    }
    if (entry.name === 'assets/app.config' || entry.name === 'assets/expo-constants.json') {
      try {
        const jsonContent = JSON.parse(entryBytes(entry).toString('utf8'));
        const suppressed = suppressExpoUpdates(jsonContent);
        return createEntry(entry.name, Buffer.from(JSON.stringify(suppressed, null, 2)), { store: false });
      } catch (ignored) {}
    }
    return entry;
  });

  if (gatewayTemplateHbc && gatewayTemplateJson) {
    const recipePaths = new Set([
      'assets/recipes/gateway-template.hbc',
      'assets/recipes/gateway-template.json',
      'assets/recipes/unpaired.hbc',
    ]);
    patchedEntries = patchedEntries.filter(e => !recipePaths.has(e.name));
    patchedEntries.push(createEntry('assets/recipes/gateway-template.hbc', gatewayTemplateHbc, { store: false }));
    patchedEntries.push(createEntry('assets/recipes/gateway-template.json', gatewayTemplateJson, { store: false }));
    if (unpairedHbc) {
      patchedEntries.push(createEntry('assets/recipes/unpaired.hbc', unpairedHbc, { store: false }));
    }
  }

  if (dexPatchResult.vmRunnerHooked) {
    const verPairipStrings = path.join(RECIPES_DIR, `pairip-strings-${manifestInfo.versionCode}.json.gz`);
    const p3212 = path.join(RECIPES_DIR, 'pairip-strings-3212.json.gz');
    const pairipStringsPath = fs.existsSync(verPairipStrings)
      ? verPairipStrings
      : (dexEntriesContainClass(zip.entries, 'LA8/bz/yZRwhmjNwa;') && fs.existsSync(p3212)
          ? p3212
          : null);
    if (pairipStringsPath) {
      const pairipStringsJson = zlib.gunzipSync(fs.readFileSync(pairipStringsPath));
      patchedEntries = patchedEntries.filter(e => e.name !== 'assets/recipes/pairip-strings.json');
      patchedEntries.push(createEntry('assets/recipes/pairip-strings.json', pairipStringsJson, { store: false }));
    }
  }

  // 7b. Inject runtime preconfiguration asset when --host or --pairing-code is provided
  if (options.host || options.pairingCode) {
    patchedEntries = patchedEntries.filter(e => e.name !== 'assets/rokbot-preconfig.json');
    const preconfig = {
      host: options.host || '',
      pairingCode: options.pairingCode || '',
    };
    patchedEntries.push(
      createEntry('assets/rokbot-preconfig.json', Buffer.from(JSON.stringify(preconfig, null, 2)), { store: false })
    );
  }

  // 7c. Inject default incremental update feed config when --update-url is provided
  if (options.updateUrl) {
    patchedEntries = patchedEntries.filter(e => e.name !== 'assets/recipes/update-config.json');
    const updateCfg = { updateFeedUrl: String(options.updateUrl).trim() };
    patchedEntries.push(
      createEntry('assets/recipes/update-config.json', Buffer.from(JSON.stringify(updateCfg, null, 2)), { store: false })
    );
  }

  // 7d. Replace or insert RokBot Android launcher mipmap icons from assets/logo/android/
  const iconResult = patchLauncherIcons(patchedEntries, options.logoDir || LOGO_ANDROID_DIR);
  patchedEntries = iconResult.entries;

  // 8. Align ZIP (16KB .so, 4B data), Sign APK, and Post-Verify Output APK Certificate
  const unsignedApk = writeZip(patchedEntries);
  const outPath = path.resolve(options.outputApk);
  let finalApkBytes;
  let signingMode;
  let usedKeystorePath = null;
  let devSigningUsed = false;
  let signingCertificateSha256 = null;
  let signingVerification = null;

  if (options.unsigned) {
    finalApkBytes = unsignedApk;
    signingMode = 'unsigned';
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, finalApkBytes);
  } else {
    const signingSchemes = manifestPin.compatibility?.signingSchemes || ['v2', 'v3'];
    const signingMinSdk = manifestPin.compatibility?.minSdk || 28;
    const expectedPinSha256 = options.expectedCertificateSha256 || RELEASE_CERTIFICATE_SHA256;
    const loaded = resolveReleaseSigningIdentity({
      keystorePath: options.keystore,
      devSigning: options.devSigning,
      expectedCertificateSha256: expectedPinSha256,
      allowAutoCreate: true,
      repoAndroidDir: REPO_ANDROID_DIR,
    });
    usedKeystorePath = loaded.keystorePath;
    devSigningUsed = loaded.devSigning;
    signingCertificateSha256 = loaded.certificateSha256;
    finalApkBytes = signApk(unsignedApk, loaded.identity, {
      schemes: signingSchemes,
      minSdk: signingMinSdk,
    });
    signingMode = 'signed-v2-v3';

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmpOutPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmpOutPath, finalApkBytes);
      const verified = assertSignedApkCertificate({
        apkPath: tmpOutPath,
        apkBytes: finalApkBytes,
        expectedCertificateSha256: loaded.certificateSha256,
        enforceReleasePin: !loaded.devSigning,
        releaseCertificateSha256: expectedPinSha256,
        minSdk: signingMinSdk,
        keystorePath: loaded.keystorePath,
      });
      signingCertificateSha256 = verified.certificateSha256;
      signingVerification = {
        verified: verified.verified,
        verifier: verified.verifier,
        certificateSha256: verified.certificateSha256,
        matchesReleasePin: verified.matchesReleasePin,
      };
      fs.renameSync(tmpOutPath, outPath);
    } catch (err) {
      try {
        if (fs.existsSync(tmpOutPath)) fs.unlinkSync(tmpOutPath);
      } catch { /* ignore cleanup error */ }
      throw err;
    }
  }

  const durationSeconds = (Date.now() - started) / 1000;
  const outputSha256 = sha256Buffer(finalApkBytes);
  const supportedPackages = manifestPin.supportedPackages || [manifestPin.packageName];
  const pkgMatched = supportedPackages.includes(manifestInfo.packageName);

  const report = {
    schema: 'rokbot-android-patch-report/v1',
    mode: 'rn-official-apk-patch',
    targetPackage: manifestPin.packageName,
    supportedPackages,
    targetVersion: manifestPin.version,
    targetBuild: parseInt(manifestPin.build, 10),
    packageName: targetPackageName,
    originalPackageName: manifestInfo.packageName,
    actualPackageName: manifestInfo.packageName,
    actualVersionName: manifestInfo.versionName,
    upstreamVersionCode: manifestInfo.versionCode,
    versionName: outputVersion.versionName ?? manifestInfo.versionName,
    versionCode: outputVersion.versionCode ?? manifestInfo.versionCode,
    pinMatched: Boolean(pkgMatched && hbcPinMatched === true),
    hbcPinMatched,
    bundlePatchMode,
    settingsRebrand: settingsRebrand
      ? {
          applied: settingsRebrand.applied, reason: settingsRebrand.reason, edits: settingsRebrand.edits,
          ...(settingsRebrand.connectionEntry ? { connectionEntry: settingsRebrand.connectionEntry } : {}),
          ...(settingsRebrand.homeBell ? { homeBell: settingsRebrand.homeBell } : {}),
          ...(settingsRebrand.listSort ? { listSort: settingsRebrand.listSort } : {}),
        }
      : { applied: false, reason: 'bundle not pinned', edits: [] },
    bytepatchApplied,
    inputApk: path.resolve(options.inputApk),
    outputApk: outPath,
    inputSha256,
    outputSha256,
    seconds: Math.round(durationSeconds * 1000) / 1000,
    signing: signingMode,
    devSigning: devSigningUsed,
    signingCertificateSha256,
    signingVerification,
    keystorePath: usedKeystorePath,
    alignment: '16kb-so-4byte-data',
    manifestPatched: true,
    setApplicationName,
    isSplitArchive: zip.isSplitArchive,
    mergedSplits: zip.mergedSplits,
    pairipDetected: pairipMarkers.length > 0,
    pairipNeutralized: dexPatchResult.pairipPatched,
    pairipElfPatched: elfPatchResult.elfFilesPatched,
    pairipElfDataPatched: elfPatchResult.elfDataPatched,
    vmRunnerHooked: dexPatchResult.vmRunnerHooked,
    okhttpHooked: dexPatchResult.okhttpPatched,
    dexInjected: dexResult.injectedName,
    tailcatLibsInjected: tailcatResult.injected,
    bundlePatched,
    expoUpdatesDisabled: true,
    cleartextTrafficAllowed: true,
    preconfiguredHost: Boolean(options.host),
    launcherIconsReplaced: iconResult.replaced,
    launcherIconsInserted: iconResult.inserted,
    adaptiveIconsPatched: iconResult.adaptiveIconsPatched,
    brandDrawablesReplaced: iconResult.brandDrawablesReplaced,
    iconBackgroundPatched: iconResult.iconBackgroundPatched,
    splashDensitiesAdded: iconResult.splashDensitiesAdded || [],
  };

  const reportPath = path.join(path.dirname(outPath), 'patch-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  return report;
}

async function main() {
  const options = parseCliArgs();

  if (options.help) {
    console.log(`
Usage:
  patch-android.mjs --input-apk <path> --output-apk <path> [options]

Options:
  --input-apk <path>      Official ai.x.grok.bot / co.anysphere.sand .xapk/.apks/.apk
  --output-apk <path>     Destination path for patched APK (required)
  --package-name <id>     Override Android package/applicationId (alias: --bundle-id)
  --bundle-id <id>        Alias for --package-name
  --host <url>            Pre-configured Host address (e.g. http://192.168.1.100:18080 or tailcat://connect/...)
  --pairing-code <code>   Pre-configured 6-character pairing code
  --update-url <url>      Default incremental update feed URL baked into assets/recipes/update-config.json
  --rokbot-build <n>      RokBot release number 1-99: versionCode = upstream*100+n (3212 -> 321201),
                          versionName = <upstream>-rokbot.<n>; must grow for in-place upgrades
  --version-code <n>      Explicit output versionCode (overrides --rokbot-build)
  --version-name <s>      Explicit output versionName (overrides --rokbot-build)
  --keystore <path>       Release JSON signing identity path (default ~/.rokbot-local/android-signing.json;
                          release mode requires an existing keystore matching android/release/signing-pin.json)
  --dev-signing           Explicitly allow temporary / non-release signing key for dev/testing
                          (or set ROKBOT_ANDROID_DEV_SIGNING=1; prints warning and sets devSigning: true)
  --unsigned              Output aligned unsigned APK
  --verify-only           Validate input APK/XAPK and recipe pins without writing output
  --force                 Overwrite existing output APK
  --force-hbc             Force HBC offset splicing even when bundle SHA-256 differs from recipe pin
  --verbose               Verbose output
  -h, --help              Show this help message
`);
    process.exit(0);
  }

  try {
    const result = await runPatchPipeline(options);
    if (options.verbose || options.verifyOnly) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Patched APK generated successfully: ${options.outputApk} (SHA-256: ${result.outputSha256})`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main();
}
