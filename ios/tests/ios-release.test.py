"""Release CLI failure paths, using only temporary synthetic input (no Xcode or device)."""
from pathlib import Path
import hashlib
import json
import os
import plistlib
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile


PATCHER = Path(__file__).resolve().parents[1] / 'release' / 'patch-ios.py'
APP_PATCHER = PATCHER.parents[1] / 'patchers' / 'ios' / 'patch-app.py'
MANIFEST = PATCHER.parents[1] / 'recipes' / 'ios' / 'manifest.json'
ICON_DIR = PATCHER.parents[2] / 'assets' / 'logo' / 'ios'
LOGO_MANIFEST = PATCHER.parents[2] / 'assets' / 'logo' / 'manifest.json'
IOS_ROOT = PATCHER.parents[1]
REPO_ROOT = PATCHER.parents[2]


def synthetic_arm64_macho():
    # Minimal thin arm64 Mach-O with one LC_SEGMENT_64 (__TEXT/__text) at fileoff 4096,
    # leaving generous zero header padding for LC_LOAD_DYLIB injection.
    section = struct.pack('<16s16sQQIIIIIIII', b'__text', b'__TEXT', 0x100004000, 64, 4096, 2, 0, 0, 0, 0, 0, 0)
    seg_cmd_size = 72 + len(section)
    segment = struct.pack('<II16sQQQQIIII', 0x19, seg_cmd_size, b'__TEXT', 0x100000000, 8192, 0, 4160, 7, 5, 1, 0) + section
    header = struct.pack('<IIIIIIII', 0xfeedfacf, 0x100000c, 0, 2, 1, len(segment), 0, 0)
    payload = bytearray(4160)
    payload[:len(header)] = header
    payload[len(header):len(header) + len(segment)] = segment
    payload[4096:4160] = b'\xc0\x03\x5f\xd6' * 16
    return bytes(payload)


class ReleaseOutput(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='rokbot-ios-release-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'demo.ipa'
        self.output = self.root / 'result'

    def refused(self, reason, patcher=PATCHER):
        before = self.source.read_bytes()
        result = subprocess.run([sys.executable, '-B', str(patcher), '--input', str(self.source),
                                 '--output', str(self.output)], capture_output=True, encoding='utf-8',
                                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(reason, result.stderr)
        self.assertEqual(self.source.read_bytes(), before)

    def app_metadata(self, version, build, identifier='co.anysphere.sand'):
        with zipfile.ZipFile(self.source, 'w') as archive:
            archive.writestr('Payload/Demo.app/Info.plist', plistlib.dumps({'CFBundleIdentifier': identifier,
                'CFBundleShortVersionString': version, 'CFBundleVersion': build, 'CFBundleExecutable': 'Demo'}))
            archive.writestr('Payload/Demo.app/Demo', b'synthetic, not an executable')

    def test_rejects_wrong_version_build_or_bundle_identifier_independently(self):
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        for version, build, identifier in [(pins['version'] + '.1', pins['build'], 'co.anysphere.sand'),
                                           (pins['version'], pins['build'] + '0', 'co.anysphere.sand'),
                                           (pins['version'], pins['build'], 'dev.fixture.demo')]:
            with self.subTest(version=version, build=build, identifier=identifier):
                self.app_metadata(version, build, identifier)
                self.refused('Unsupported app version')
                self.assertEqual(list(self.root.iterdir()), [self.source])
        self.app_metadata(pins['version'], pins['build'])
        self.refused('Expected thin arm64 executable')
        self.assertEqual(list(self.root.iterdir()), [self.source])

    def test_metadata_gate_and_help_follow_the_packaged_manifest(self):
        # Copy only the release scripts and manifest into an isolated package. No working
        # IPA, patch recipes or native library are supplied: the binary gate must still fail.
        package = self.root / 'fixture-package'
        patcher = package / 'release' / PATCHER.name
        patcher.parent.mkdir(parents=True)
        for name in (PATCHER.name, 'bytepatch.py', 'native_text.py'):
            shutil.copyfile(PATCHER.with_name(name), patcher.with_name(name))
        manifest = package / 'recipes' / 'ios' / 'manifest.json'
        manifest.parent.mkdir(parents=True)
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        pins.update(version='0.0.7', build='9001')
        manifest.write_text(json.dumps(pins), encoding='utf-8')
        self.app_metadata(pins['version'], pins['build'])
        self.refused('Expected thin arm64 executable', patcher)
        help_text = subprocess.check_output([sys.executable, '-B', str(patcher), '--help'], encoding='utf-8',
                                            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        self.assertIn('0.0.7 (9001)', help_text)
        self.assertEqual(set(self.root.iterdir()), {package, self.source})

    def test_invalid_archive_leaves_no_output(self):
        self.source.write_bytes(b'demo, not an archive')
        self.refused('not a zip file')
        self.assertEqual(list(self.root.iterdir()), [self.source])

    def test_unsupported_app_leaves_no_output(self):
        with zipfile.ZipFile(self.source, 'w') as archive:
            archive.writestr('Payload/Demo.app/Info.plist', plistlib.dumps({'CFBundleIdentifier': 'dev.fixture.demo'}))
        self.refused('Unsupported app version')
        self.assertEqual(list(self.root.iterdir()), [self.source])

    def test_existing_output_is_unchanged(self):
        self.source.write_bytes(b'demo')
        self.output.mkdir()
        previous = self.output / 'prior-build'
        previous.write_bytes(b'original')
        self.refused('Output exists')
        self.assertEqual(list(self.output.iterdir()), [previous])
        self.assertEqual(previous.read_bytes(), b'original')
        self.assertEqual(set(self.root.iterdir()), {self.source, self.output})

    def test_patch_app_rebrands_injects_dylib_and_wires_app_icons(self):
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        source_app = self.root / 'Demo.app'
        source_app.mkdir()
        (source_app / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': 'co.anysphere.sand',
            'CFBundleShortVersionString': pins['version'],
            'CFBundleVersion': pins['build'],
            'CFBundleExecutable': 'Demo',
            'CFBundleDisplayName': 'Grok Bot',
            'CFBundleIconName': 'AppIcon',
            'CFBundleIconFiles': ['AppIcon60x60'],
            'CFBundleIconFile': 'AppIcon.png',
            'GrokBotPresenceAppGroup': 'group.co.anysphere.sand',
        }))
        (source_app / 'Expo.plist').write_bytes(plistlib.dumps({'EXUpdatesEnabled': True, 'EXUpdatesURL': 'https://example.invalid/update'}))
        (source_app / 'Demo').write_bytes(synthetic_arm64_macho())
        (source_app / 'AppIcon60x60@2x.png').write_bytes(b'stale-icon')
        (source_app / 'Assets.car').write_bytes(b'RN_ASSETS_CAR')
        (source_app / 'main.jsbundle').write_bytes(b'original-hbc')

        dylib = self.root / 'RokBotLocal.dylib'
        dylib.write_bytes(b'synthetic-dylib')
        resources = self.root / 'resources'
        resources.mkdir()
        (resources / 'gateway-template.hbc').write_bytes(b'gateway-hbc')
        (resources / 'unpaired.hbc').write_bytes(b'unpaired-hbc')

        result = subprocess.run(
            [sys.executable, '-B', str(APP_PATCHER),
             '--source', str(source_app), '--output', str(self.output),
             '--dylib', str(dylib), '--resources', str(resources),
             '--unsigned', '--remove-extensions'],
            capture_output=True, encoding='utf-8',
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

        report = json.loads((self.output / 'patch-report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['schema'], 'rokbot-ios-app-patch/v1')
        self.assertEqual(report['bundleId'], 'dev.rokbot.local')
        self.assertTrue(report['dylibInjected'])
        self.assertFalse(report['expoUpdatesEnabled'])
        self.assertEqual(report['signing'], 'unsigned')

        ipa = self.output / 'RokBot-Local-resignable.ipa'
        self.assertTrue(ipa.is_file())
        patched_app = self.output / 'Payload' / 'Demo.app'
        self.assertTrue((patched_app / 'Frameworks' / 'RokBotLocal.dylib').is_file())
        self.assertFalse((patched_app / 'Frameworks' / 'GrokBotLocal.dylib').exists())
        self.assertTrue((patched_app / 'Frameworks' / 'RokBotLocal.bundle' / 'unpaired.hbc').is_file())
        self.assertEqual((patched_app / 'main.jsbundle').read_bytes(), b'unpaired-hbc')
        self.assertEqual((patched_app / 'Assets.car').read_bytes(), b'RN_ASSETS_CAR')
        self.assertFalse((patched_app / 'AppIcon60x60@2x.png').exists())

        info = plistlib.loads((patched_app / 'Info.plist').read_bytes())
        self.assertEqual(info['CFBundleIdentifier'], 'dev.rokbot.local')
        self.assertEqual(info['CFBundleDisplayName'], 'RokBot')
        self.assertEqual(info['CFBundleURLTypes'][0]['CFBundleURLSchemes'], ['rokbot-local', 'rblocal', 'rblocal-ios'])
        self.assertEqual(info['SandAppGroupIdentifier'], 'group.dev.rokbot.local')
        self.assertNotIn('GrokBotPresenceAppGroup', info)
        for legacy_key in ('CFBundleIconName', 'CFBundleIconFiles', 'CFBundleIconFile'):
            self.assertNotIn(legacy_key, info)
        self.assertEqual(info['CFBundleIcons'], {'CFBundlePrimaryIcon': {'CFBundleIconFiles': ['RokBotAppIcon60x60']}})
        self.assertEqual(info['CFBundleIcons~ipad'], {'CFBundlePrimaryIcon': {'CFBundleIconFiles': ['RokBotAppIcon60x60', 'RokBotAppIcon76x76', 'RokBotAppIcon83.5x83.5']}})

        expected_icons = {
            'RokBotAppIcon60x60@2x.png': 'AppIcon-120.png',
            'RokBotAppIcon60x60@3x.png': 'AppIcon-180.png',
            'RokBotAppIcon76x76@2x~ipad.png': 'AppIcon-152.png',
            'RokBotAppIcon83.5x83.5@2x~ipad.png': 'AppIcon-167.png',
            'RokBotAppIcon1024x1024.png': 'AppIcon-1024.png',
        }
        with zipfile.ZipFile(ipa) as z:
            names = set(z.namelist())
            for dst_name, src_name in expected_icons.items():
                expected_bytes = (ICON_DIR / src_name).read_bytes()
                self.assertEqual((patched_app / dst_name).read_bytes(), expected_bytes)
                self.assertIn(f'Payload/Demo.app/{dst_name}', names)
                self.assertEqual(z.read(f'Payload/Demo.app/{dst_name}'), expected_bytes)
            self.assertNotIn('Payload/Demo.app/AppIcon60x60@2x.png', names)
            self.assertIn('Payload/Demo.app/Assets.car', names)
            self.assertIn('Payload/Demo.app/Frameworks/RokBotLocal.dylib', names)
            self.assertIn('Payload/Demo.app/Frameworks/RokBotLocal.bundle/gateway-template.hbc', names)

        injected_exe = (patched_app / 'Demo').read_bytes()
        self.assertIn(b'@executable_path/Frameworks/RokBotLocal.dylib\0', injected_exe)

    def test_patch_app_icon_manifest_integrity_and_missing_icon_failure(self):
        logo_manifest = json.loads(LOGO_MANIFEST.read_text(encoding='utf-8'))
        ios_icons = logo_manifest.get('ios') or []
        self.assertEqual(len(ios_icons), 5)
        for entry in ios_icons:
            icon_path = REPO_ROOT / entry['path']
            self.assertTrue(icon_path.is_file(), f'Missing icon: {icon_path}')
            data = icon_path.read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), entry['sha256'])
            self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
            width, height, bit_depth, color_type = struct.unpack('>IIBB', data[16:26])
            self.assertEqual((width, height), (entry['width'], entry['height']))
            self.assertEqual(bit_depth, 8)
            self.assertEqual(color_type, 2)  # RGB without alpha channel
            self.assertFalse(entry['hasAlpha'])

        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        source_app = self.root / 'Demo.app'
        source_app.mkdir()
        (source_app / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': 'co.anysphere.sand',
            'CFBundleShortVersionString': pins['version'],
            'CFBundleVersion': pins['build'],
            'CFBundleExecutable': 'Demo',
        }))
        (source_app / 'Expo.plist').write_bytes(plistlib.dumps({'EXUpdatesEnabled': True}))
        (source_app / 'Demo').write_bytes(synthetic_arm64_macho())
        dylib = self.root / 'RokBotLocal.dylib'
        dylib.write_bytes(b'synthetic-dylib')
        resources = self.root / 'resources'
        resources.mkdir()
        (resources / 'gateway-template.hbc').write_bytes(b'gateway-hbc')
        (resources / 'unpaired.hbc').write_bytes(b'unpaired-hbc')

        broken_icons = self.root / 'broken-icons'
        broken_icons.mkdir()
        for src in ICON_DIR.glob('*.png'):
            if src.name != 'AppIcon-180.png':
                shutil.copy2(src, broken_icons / src.name)

        result = subprocess.run(
            [sys.executable, '-B', str(APP_PATCHER),
             '--source', str(source_app), '--output', str(self.output),
             '--dylib', str(dylib), '--resources', str(resources),
             '--icon-dir', str(broken_icons), '--unsigned', '--remove-extensions'],
            capture_output=True, encoding='utf-8',
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing RokBot AppIcon asset', result.stderr)
        self.assertFalse((self.output / 'RokBot-Local-resignable.ipa').exists())

    def test_patch_app_info_plist_clears_legacy_ipad_icons_sets_bundle_name_and_updater_schemes(self):
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        source_app = self.root / 'Demo.app'
        source_app.mkdir()
        (source_app / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': 'co.anysphere.sand',
            'CFBundleShortVersionString': pins['version'],
            'CFBundleVersion': pins['build'],
            'CFBundleExecutable': 'Demo',
            'CFBundleName': 'GrokBotOld',
            'CFBundleDisplayName': 'Grok Bot',
            'CFBundleIconName': 'AppIcon',
            'CFBundleIconFiles': ['AppIcon60x60'],
            'CFBundleIconFiles~ipad': ['AppIcon76x76'],
            'CFBundleIconFile': 'AppIcon.png',
            'CFBundleIcons': {
                'CFBundlePrimaryIcon': {'CFBundleIconName': 'AppIcon', 'CFBundleIconFiles': ['AppIcon60x60']},
                'CFBundleAlternateIcons': {'Alt': {'CFBundleIconFiles': ['AltIcon']}},
            },
            'CFBundleIcons~iphone': {'CFBundlePrimaryIcon': {'CFBundleIconFiles': ['AppIcon60x60']}},
            'UILaunchImages': [{'UILaunchImageName': 'LaunchImage'}],
            'UILaunchScreen': {'UIImageName': 'AppIcon', 'UIColorName': 'LaunchBackground'},
            'NSMicrophoneUsageDescription': 'Grok Bot needs microphone access',
            'NSCameraUsageDescription': 'GrokBot needs camera access',
            'LSApplicationQueriesSchemes': ['custom-scheme', 'altstore', 'custom-scheme'],
        }))
        lproj = source_app / 'en.lproj'
        lproj.mkdir()
        (lproj / 'InfoPlist.strings').write_bytes(plistlib.dumps({
            'CFBundleDisplayName': 'Grok Bot',
            'CFBundleName': 'GrokBot',
            'NSMicrophoneUsageDescription': 'Grok Bot needs microphone access',
        }, fmt=plistlib.FMT_BINARY))
        (source_app / 'Expo.plist').write_bytes(plistlib.dumps({'EXUpdatesEnabled': True}))
        (source_app / 'Demo').write_bytes(synthetic_arm64_macho())
        dylib = self.root / 'RokBotLocal.dylib'
        dylib.write_bytes(b'synthetic-dylib')
        resources = self.root / 'resources'
        resources.mkdir()
        (resources / 'gateway-template.hbc').write_bytes(b'gateway-hbc')
        (resources / 'unpaired.hbc').write_bytes(b'unpaired-hbc')

        result = subprocess.run(
            [sys.executable, '-B', str(APP_PATCHER),
             '--source', str(source_app), '--output', str(self.output),
             '--dylib', str(dylib), '--resources', str(resources),
             '--unsigned', '--remove-extensions'],
            capture_output=True, encoding='utf-8',
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

        info = plistlib.loads((self.output / 'Payload' / 'Demo.app' / 'Info.plist').read_bytes())
        for legacy_key in ('CFBundleIconName', 'CFBundleIconFiles', 'CFBundleIconFiles~ipad', 'CFBundleIconFile',
                           'CFBundleIcons~iphone', 'UILaunchImages'):
            self.assertNotIn(legacy_key, info)
        self.assertNotIn('CFBundleAlternateIcons', info['CFBundleIcons'])
        self.assertNotIn('CFBundleIconName', info['CFBundleIcons']['CFBundlePrimaryIcon'])
        self.assertEqual(info['CFBundleName'], 'RokBot')
        self.assertEqual(info['CFBundleDisplayName'], 'RokBot')
        self.assertEqual(info['UILaunchScreen'], {'UIImageName': 'RokBotAppIcon60x60', 'UIColorName': 'LaunchBackground'})
        self.assertEqual(info['NSMicrophoneUsageDescription'], 'RokBot needs microphone access')
        self.assertEqual(info['NSCameraUsageDescription'], 'RokBot needs camera access')
        self.assertEqual(info['LSApplicationQueriesSchemes'], ['custom-scheme', 'altstore', 'sidestore', 'itms-services'])

        loc_strings = plistlib.loads((self.output / 'Payload' / 'Demo.app' / 'en.lproj' / 'InfoPlist.strings').read_bytes())
        self.assertEqual(loc_strings['CFBundleDisplayName'], 'RokBot')
        self.assertEqual(loc_strings['CFBundleName'], 'RokBot')
        self.assertEqual(loc_strings['NSMicrophoneUsageDescription'], 'RokBot needs microphone access')

    def test_patch_app_ignores_non_list_application_queries_schemes(self):
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        source_app = self.root / 'Demo.app'
        source_app.mkdir()
        (source_app / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': 'co.anysphere.sand',
            'CFBundleShortVersionString': pins['version'],
            'CFBundleVersion': pins['build'],
            'CFBundleExecutable': 'Demo',
            'LSApplicationQueriesSchemes': 'fb',
        }))
        (source_app / 'Expo.plist').write_bytes(plistlib.dumps({'EXUpdatesEnabled': True}))
        (source_app / 'Demo').write_bytes(synthetic_arm64_macho())
        dylib = self.root / 'RokBotLocal.dylib'
        dylib.write_bytes(b'synthetic-dylib')
        resources = self.root / 'resources'
        resources.mkdir()
        (resources / 'gateway-template.hbc').write_bytes(b'gateway-hbc')
        (resources / 'unpaired.hbc').write_bytes(b'unpaired-hbc')

        result = subprocess.run(
            [sys.executable, '-B', str(APP_PATCHER),
             '--source', str(source_app), '--output', str(self.output),
             '--dylib', str(dylib), '--resources', str(resources),
             '--unsigned', '--remove-extensions'],
            capture_output=True, encoding='utf-8',
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

        info = plistlib.loads((self.output / 'Payload' / 'Demo.app' / 'Info.plist').read_bytes())
        self.assertEqual(info['LSApplicationQueriesSchemes'], ['altstore', 'sidestore', 'itms-services'])

    def test_unsigned_report_dylib_sha_matches_shipped_signature_stripped_dylib(self):
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        source_app = self.root / 'Demo.app'
        source_app.mkdir()
        (source_app / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': 'co.anysphere.sand',
            'CFBundleShortVersionString': pins['version'],
            'CFBundleVersion': pins['build'],
            'CFBundleExecutable': 'Demo',
        }))
        (source_app / 'Expo.plist').write_bytes(plistlib.dumps({'EXUpdatesEnabled': True}))
        (source_app / 'Demo').write_bytes(synthetic_arm64_macho())
        # Signed synthetic dylib: one LC_CODE_SIGNATURE (16-byte command) whose
        # blob sits at the end of the file, like an ad-hoc signed build.py output.
        body = bytearray(synthetic_arm64_macho())
        struct.pack_into('<I', body, 12, 6)  # MH_DYLIB
        blob_offset, blob = len(body), b'\xfa\xde\x0c\xc0' * 16
        sizeofcmds = struct.unpack_from('<I', body, 20)[0]
        struct.pack_into('<IIII', body, 32 + sizeofcmds, 0x1d, 16, blob_offset, len(blob))
        struct.pack_into('<I', body, 16, 2)
        struct.pack_into('<I', body, 20, sizeofcmds + 16)
        signed = bytes(body) + blob
        dylib = self.root / 'RokBotLocal.dylib'
        dylib.write_bytes(signed)
        resources = self.root / 'resources'
        resources.mkdir()
        (resources / 'gateway-template.hbc').write_bytes(b'gateway-hbc')
        (resources / 'unpaired.hbc').write_bytes(b'unpaired-hbc')

        result = subprocess.run(
            [sys.executable, '-B', str(APP_PATCHER),
             '--source', str(source_app), '--output', str(self.output),
             '--dylib', str(dylib), '--resources', str(resources),
             '--unsigned', '--remove-extensions'],
            capture_output=True, encoding='utf-8',
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.output / 'patch-report.json').read_text(encoding='utf-8'))
        shipped = (self.output / 'Payload' / 'Demo.app' / 'Frameworks' / 'RokBotLocal.dylib').read_bytes()
        self.assertNotEqual(shipped, signed, 'unsigned export must strip LC_CODE_SIGNATURE')
        self.assertEqual(struct.unpack_from('<I', shipped, 16)[0], 1)
        self.assertEqual(report['dylibSha256'], hashlib.sha256(shipped).hexdigest())
        self.assertEqual(report['sourceDylibSha256'], hashlib.sha256(signed).hexdigest())
        with zipfile.ZipFile(self.output / 'RokBot-Local-resignable.ipa') as ipa:
            packed = ipa.read('Payload/Demo.app/Frameworks/RokBotLocal.dylib')
        self.assertEqual(report['dylibSha256'], hashlib.sha256(packed).hexdigest())

    def test_release_delivers_the_shipped_dylib_next_to_the_report(self):
        source = PATCHER.read_text(encoding='utf-8')
        self.assertIn("glob('*.app/Frameworks/RokBotLocal.dylib')", source)
        self.assertIn("!= report['dylibSha256']", source)
        self.assertNotIn("shutil.copy2(dylib, work / 'patched/RokBotLocal.dylib')", source)

    def test_dylib_binary_is_executable_thin_arm64_and_matches_manifest_pin(self):
        dylib = IOS_ROOT / 'bin' / 'RokBotLocal.dylib'
        self.assertTrue(dylib.is_file())
        self.assertEqual(stat.S_IMODE(dylib.stat().st_mode), 0o755)
        data = dylib.read_bytes()
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        self.assertEqual(hashlib.sha256(data).hexdigest(), pins['dylibSha256'])

        magic, cputype, _, filetype, ncmds, sizeofcmds, _, _ = struct.unpack_from('<IIIIIIII', data, 0)
        self.assertEqual(magic, 0xfeedfacf)
        self.assertEqual(cputype, 0x100000c)  # arm64
        self.assertEqual(filetype, 6)  # MH_DYLIB
        offset = 32
        end = 32 + sizeofcmds
        self.assertLessEqual(end, len(data))
        for _ in range(ncmds):
            cmd, cmdsize = struct.unpack_from('<II', data, offset)
            if cmd in (0x21, 0x2c):  # LC_ENCRYPTION_INFO / LC_ENCRYPTION_INFO_64
                cryptid = struct.unpack_from('<I', data, offset + 16)[0]
                self.assertEqual(cryptid, 0)
            offset += cmdsize
        self.assertEqual(offset, end)

    def test_all_ios_client_sources_wired_into_build_py_and_iphoneos_syntax(self):
        build_py = (IOS_ROOT / 'clients' / 'ios' / 'build.py').read_text(encoding='utf-8')
        sources = sorted((IOS_ROOT / 'clients' / 'ios').glob('*.m'))
        self.assertGreater(len(sources), 0)
        for src in sources:
            self.assertIn(src.name, build_py, f'{src.name} missing from ios/clients/ios/build.py')

        if sys.platform == 'darwin' and shutil.which('xcrun'):
            sdk_proc = subprocess.run(['xcrun', '--sdk', 'iphoneos', '--show-sdk-path'],
                                      capture_output=True, text=True, timeout=10)
            if sdk_proc.returncode == 0:
                sdk = sdk_proc.stdout.strip()
                cmd = [
                    'xcrun', '--sdk', 'iphoneos', 'clang', '-arch', 'arm64', '-isysroot', sdk,
                    '-miphoneos-version-min=15.1', '-fobjc-arc', '-fblocks', '-O2',
                    '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter',
                    '-Wno-deprecated-declarations', '-Wno-nullability-completeness',
                    '-DROKBOT_VOICE_AEC3=1', '-fsyntax-only',
                ] + [str(s) for s in sources]
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
                self.assertEqual(res.returncode, 0, res.stderr)

    def test_compiled_objc_client_helpers_runtime(self):
        helper_test = IOS_ROOT / 'tests' / 'ios-client-helpers.test.m'
        self.assertTrue(helper_test.is_file())
        with tempfile.TemporaryDirectory(prefix='rokbot-objc-helpers-', dir=self.root) as work:
            exe = Path(work) / 'helpers-test'
            compile_res = subprocess.run([
                'clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
                '-Wno-unused-parameter', '-Wno-deprecated-declarations', '-Wno-nullability-completeness',
                '-framework', 'Foundation', '-framework', 'Security',
                str(helper_test), '-o', str(exe),
            ], capture_output=True, text=True, cwd=IOS_ROOT, timeout=30)
            self.assertEqual(compile_res.returncode, 0, compile_res.stderr)
            run_res = subprocess.run([str(exe)], capture_output=True, text=True, timeout=15)
            self.assertEqual(run_res.returncode, 0, run_res.stderr + run_res.stdout)
            self.assertIn('PASS: RBDeviceIdentity', run_res.stdout)
            self.assertIn('PASS: RBModels', run_res.stdout)
            self.assertIn('PASS: RBUpdater', run_res.stdout)
            self.assertIn('PASS: RBModels scenario routes', run_res.stdout)
            self.assertIn('PASS: RBSuggestions', run_res.stdout)
            self.assertIn('PASS: RBCanvas', run_res.stdout)
            self.assertIn('PASS: RBGroupCreate', run_res.stdout)
            self.assertIn('PASS: RBMigrate', run_res.stdout)

    def test_ios_client_device_id_models_updater_and_docs_contracts(self):
        conn = (IOS_ROOT / 'clients' / 'ios' / 'RBConnection.m').read_text(encoding='utf-8')
        self.assertIn('RBClientDeviceId()', conn)
        self.assertIn('@"bundleId"', conn)
        self.assertIn('@"password"', conn)
        self.assertIn('@"pairingKey"', conn)
        self.assertIn('rokbot.host.models', conn)
        self.assertIn('rokbot.host.updates', conn)
        self.assertIn('RBShowModelsFrom(self)', conn)
        self.assertIn('RBShowUpdaterFrom(self)', conn)
        self.assertIn('RBConnBoolValue', conn)
        self.assertIn('RBConnAsString', conn)
        self.assertNotIn('[result[@"connected"] boolValue]', conn)
        disconnect_section = conn.split('- (void)disconnect {', 1)[1].split('@end', 1)[0]
        disconnect_code = '\n'.join(
            line for line in disconnect_section.splitlines()
            if not line.lstrip().startswith('//')
        )
        self.assertNotIn('client-device-id', disconnect_code)
        self.assertNotIn('RokBotLocal.clientDeviceId', disconnect_code)

        push = (IOS_ROOT / 'clients' / 'ios' / 'RBPush.m').read_text(encoding='utf-8')
        self.assertIn('@"clientDeviceId": RBClientDeviceId()', push)
        self.assertIn('RBPushBoolValue', push)
        self.assertIn('RBPushAsString', push)
        self.assertIn('RBPushAsDict', push)
        self.assertNotIn('[value[@"push"][@"configured"] boolValue]', push)
        self.assertNotIn('[value[@"push"][@"enabled"] boolValue]', push)

        connectors = (IOS_ROOT / 'clients' / 'ios' / 'RBConnectors.m').read_text(encoding='utf-8')
        for method in ('UpdateUserPluginInstall', 'GetTeamPluginPopularity', 'ListPublicGrokBotMarketplaceListings'):
            self.assertIn(method, connectors)
        self.assertIn('/aiserver.v1.DashboardService/', connectors)
        self.assertIn('/aiserver.v1.GrokBotService/', connectors)
        self.assertIn('HTTPBodyStream', connectors)

        models = (IOS_ROOT / 'clients' / 'ios' / 'RBModels.m').read_text(encoding='utf-8')
        for token in ('/local/status', '/local/model', '/local/model/catalog', '/local/model/test',
                      'X-RokBot-Admin-Password', 'RBHTTPSession()', 'needsModel',
                      'autoPromptOn403:NO', 'progress.presentingViewController',
                      'transitionCoordinator', '[timer invalidate]',
                      '[top isKindOfClass:UIAlertController.class]'):
            self.assertIn(token, models)

        updater = (IOS_ROOT / 'clients' / 'ios' / 'RBUpdater.m').read_text(encoding='utf-8')
        for token in ('/local/updates/ios.json', 'rokbot-ios-update/v1', 'itms-services://',
                      '@"altstore"', '@"sidestore"', '://source?url=%@',
                      'CC_SHA256', 'UIActivityViewController', 'RBHTTPSession()',
                      'finishTasksAndInvalidate', 'viewDidDisappear:',
                      'CGRectGetMidY(self.view.bounds)',
                      '[currentTop isKindOfClass:UIAlertController.class]'):
            self.assertIn(token, updater)

        bootstrap = (IOS_ROOT / 'clients' / 'ios' / 'RBBootstrap.m').read_text(encoding='utf-8')
        self.assertIn('RBCheckModelOnboardingIfNeeded()', bootstrap)
        self.assertIn('RBCheckUpdatesInBackgroundIfNeeded()', bootstrap)

        for doc_name in ('README.md', 'README.en.md'):
            doc = (IOS_ROOT / doc_name).read_text(encoding='utf-8')
            for term in ('1.16.0', '23152', '--remove-extensions', 'itms-services',
                         'AltStore', 'SideStore', 'RBModels', 'RBUpdater', 'clientDeviceId'):
                self.assertIn(term, doc, f'{term} missing from ios/{doc_name}')

    def test_prepare_extensions_rebrands_display_name_bundle_name_and_strings(self):
        sys.path.insert(0, str(IOS_ROOT / 'patchers' / 'ios'))
        import extensions as ext_mod
        sys.path.insert(0, str(APP_PATCHER.parent))
        import importlib.util
        spec = importlib.util.spec_from_file_location('patch_app_mod', APP_PATCHER)
        patch_app_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(patch_app_mod)

        def macho_with_text(text_bytes):
            section = struct.pack('<16s16sQQIIIIIIII', b'__text', b'__TEXT', 0x100004000,
                                  len(text_bytes), 4096, 2, 0, 0, 0, 0, 0, 0)
            seg_cmd_size = 72 + len(section)
            segment = struct.pack('<II16sQQQQIIII', 0x19, seg_cmd_size, b'__TEXT', 0x100000000,
                                  4096 + len(text_bytes), 0, 4096 + len(text_bytes), 7, 5, 1, 0) + section
            header = struct.pack('<IIIIIIII', 0xfeedfacf, 0x100000c, 0, 2, 1, len(segment), 0, 0)
            payload = bytearray(4096 + len(text_bytes))
            payload[:len(header)] = header
            payload[len(header):len(header) + len(segment)] = segment
            payload[4096:] = text_bytes
            return bytes(payload)

        app = self.root / 'Demo.app'
        plugins = app / 'PlugIns'
        plugins.mkdir(parents=True)

        widget_seq = b''.join(
            struct.pack('<I', 0xd2800000 | (imm << 5))
            for imm in ext_mod.WIDGETS_SCHEME_IMMEDIATES
        )
        widget_text = b'\x00' * 0x100 + widget_seq + b'\x00' * 0x100 + widget_seq + b'\x00' * 0x100
        ext_specs = {
            'Widgets.appex': ('widgets', widget_text),
            'ImageShareExtension.appex': ('share', b'prefix-sand-mobile\0-suffix'),
            'NotificationService.appex': ('NotificationService', b'\xc0\x03\x5f\xd6' * 16),
        }
        patched_map = {}
        for appex_name, (suffix, text_bytes) in ext_specs.items():
            ext_dir = plugins / appex_name
            ext_dir.mkdir()
            (ext_dir / 'Info.plist').write_bytes(plistlib.dumps({
                'CFBundleIdentifier': 'co.anysphere.sand.' + suffix,
                'CFBundleExecutable': 'ExtBin',
                'CFBundleName': 'Grok Bot',
                'CFBundleDisplayName': 'Grok Bot',
            }))
            lproj = ext_dir / 'en.lproj'
            lproj.mkdir()
            (lproj / 'InfoPlist.strings').write_bytes(plistlib.dumps({
                'CFBundleDisplayName': 'Grok Bot',
                'CFBundleName': 'Grok Bot',
            }, fmt=plistlib.FMT_BINARY))
            (ext_dir / 'ExtBin').write_bytes(macho_with_text(text_bytes))
            patched_map[appex_name] = (suffix, hashlib.sha256(text_bytes).hexdigest())

        orig_extensions = ext_mod.EXTENSIONS
        ext_mod.EXTENSIONS = patched_map
        try:
            records = ext_mod.prepare_extensions(app, 'dev.rokbot.local', 'group.dev.rokbot.local', patch_app_mod.commands)
        finally:
            ext_mod.EXTENSIONS = orig_extensions

        self.assertEqual(len(records), 3)
        for appex_name, (suffix, _) in ext_specs.items():
            info = plistlib.loads((plugins / appex_name / 'Info.plist').read_bytes())
            self.assertEqual(info['CFBundleIdentifier'], f'dev.rokbot.local.{suffix}')
            self.assertEqual(info['CFBundleName'], 'RokBot')
            self.assertEqual(info['CFBundleDisplayName'], 'RokBot')
            self.assertEqual(info['SandAppGroupIdentifier'], 'group.dev.rokbot.local')
            loc = plistlib.loads((plugins / appex_name / 'en.lproj' / 'InfoPlist.strings').read_bytes())
            self.assertEqual(loc['CFBundleDisplayName'], 'RokBot')
            self.assertEqual(loc['CFBundleName'], 'RokBot')
        self.assertIn(b'rblocal-ios\0', (plugins / 'ImageShareExtension.appex' / 'ExtBin').read_bytes())
        widget_patched = (plugins / 'Widgets.appex' / 'ExtBin').read_bytes()
        rewritten = [
            index for index in range(len(widget_patched) - 16)
            if tuple((w >> 5) & 0xFFFF for w in struct.unpack_from('<4I', widget_patched, index))
            == ext_mod.WIDGETS_SCHEME_PARTS
        ]
        self.assertEqual(len(rewritten), 2)


if __name__ == '__main__':
    unittest.main()
