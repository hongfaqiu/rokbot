import hashlib
import io
import importlib.util
import json
import base64
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'release'))
import bytepatch

PATCH_HOST = Path(__file__).resolve().parents[1] / 'release' / 'patch-host.py'
PATCH_HOST_SPEC = importlib.util.spec_from_file_location('patch_host', PATCH_HOST)
patch_host = importlib.util.module_from_spec(PATCH_HOST_SPEC)
PATCH_HOST_SPEC.loader.exec_module(patch_host)


def pinned_host_archive(member_name='sand-host/host-main.cjs'):
    manifest = json.loads((Path(__file__).resolve().parents[1] / 'recipes' / 'host' / 'manifest.json').read_text())
    configured = os.environ.get('ROKBOT_TEST_HOST_ARCHIVE') or os.environ.get('PROKBOT_TEST_HOST_ARCHIVE')
    candidates = [Path(configured).expanduser()] if configured else [
        Path(__file__).resolve().parents[2] / 'inputs' / 'host' / f"sand-host-bundle-{manifest['archive']['version']}.tgz",
    ]
    for path in candidates:
        if path.is_file() and bytepatch.file_digest(path) == manifest['archive']['sha256']:
            with tarfile.open(path, 'r:gz') as archive:
                member = archive.extractfile(member_name)
                if member is None:
                    raise ValueError(f'Pinned Host archive has no {member_name}')
                return member.read()
    return None


class PinnedPatchTests(unittest.TestCase):
    def setUp(self):
        self.raw = bytes(range(256)) * 8
        self.target = self.raw[:300] + b'project addition' + self.raw[500:]
        self.recipe = bytepatch.create(self.raw, self.target)

    def test_many_targets_share_one_source_hash_but_each_recipe_checks_its_pin(self):
        with patch.object(bytepatch, 'digest', wraps=bytepatch.digest) as fingerprint:
            source = bytepatch.PatchSource(self.raw)
            for _ in range(3):
                output = io.BytesIO()
                source.write_verified(self.recipe, output)
                self.assertEqual(output.getvalue(), self.target)
            self.assertEqual(sum(call.args == (self.raw,) for call in fingerprint.call_args_list), 1)
        for changed in ({'sourceSha256': '0' * 64}, {'sourceBytes': 2}, {'targetSha256': '0' * 64},
                        {'targetBytes': 1}, {'ops': [['copy', 0, len(self.raw) + 1]]}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                source.write_verified({**self.recipe, **changed}, io.BytesIO())

    def test_cached_source_cannot_be_changed_after_verification(self):
        buf = bytearray(self.raw)
        source = bytepatch.PatchSource(buf)
        buf[0] ^= 1
        output = io.BytesIO()
        source.write_verified(self.recipe, output)
        self.assertEqual(output.getvalue(), self.target)

    def test_archive_digest_does_not_load_the_entire_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'input.bin'
            data = self.raw * 2048
            path.write_bytes(data)
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('unbounded file read')):
                self.assertEqual(bytepatch.file_digest(path), hashlib.sha256(data).hexdigest())

    def test_reliability_manifest_checks_generated_file_digests(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'release-reliability'
            directory.mkdir()
            content = b'prepared output'
            (directory / 'module.mjs').write_bytes(content)
            manifest = {
                'digest': 'a' * 64,
                'files': [{'name': 'module.mjs', 'sha256': hashlib.sha256(content).hexdigest()}],
            }
            (directory / 'manifest.json').write_text(json.dumps(manifest))
            patch_host.verify_reliability_manifest(Path(tmp))
            (directory / 'module.mjs').write_bytes(b'changed output')
            with self.assertRaisesRegex(ValueError, 'Prepared reliability manifest mismatch: module.mjs'):
                patch_host.verify_reliability_manifest(Path(tmp))

    def test_tool_stream_recipe_waits_for_both_error_branches(self):
        recipe = bytepatch.load(Path(__file__).resolve().parents[1] / 'recipes' / 'host' /
                                'release-reliability__engine-tool-stream-executor.mjs.gbp.gz')
        additions = b''.join(base64.b64decode(operation[1]) for operation in recipe['ops'] if operation[0] == 'add')
        self.assertIn(b'1.throw(error63), stream22.close()]', additions)
        self.assertIn(b'.catch(() => interactionHandler.invocationId)', additions)
        source = pinned_host_archive('sand-host/sand-eval-runner.cjs')
        if source is not None:
            applied = bytepatch.apply(source, recipe)
            self.assertIn(b'await Promise.allSettled([stream1.throw(error63), stream22.close()])', applied)

    def test_rejects_legacy_grokbot_and_unknown_bytepatch_schemas(self):
        self.assertEqual(self.recipe['schema'], 'rokbot-bytepatch/v1')
        for unsupported in ('grokbot-bytepatch/v1', 'other-schema/v1'):
            with self.subTest(schema=unsupported), self.assertRaisesRegex(ValueError, 'Unsupported patch schema'):
                bytepatch.apply(self.raw, {**self.recipe, 'schema': unsupported})

    def test_all_manifest_recipes_use_rokbot_schema_without_legacy_grokbot_shims(self):
        recipes_dir = Path(__file__).resolve().parents[1] / 'recipes' / 'host'
        manifest = json.loads((recipes_dir / 'manifest.json').read_text())
        self.assertEqual(manifest['archive']['version'], '97658ad')
        self.assertIn('2bb5e41', manifest.get('fallback', {}))
        fallback_manifest = json.loads((recipes_dir / manifest['fallback']['2bb5e41']['manifest']).read_text())
        self.assertEqual(fallback_manifest['archive']['version'], '2bb5e41')
        disk_recipes = sorted(p.name for p in recipes_dir.glob('*.gbp.gz'))
        manifest_recipes = sorted(entry['patch'] for entry in manifest['files'])
        self.assertEqual(disk_recipes, manifest_recipes)
        forbidden = (b'grokbot-bytepatch', b'/opt/grokbot', b'GROKBOT_RUNTIME_DIR',
                     b'GROKBOT_EXECUTION_URL', b'__grokbotPromptPolicy')
        for entry in manifest['files']:
            recipe = bytepatch.load(recipes_dir / entry['patch'])
            self.assertEqual(recipe['schema'], 'rokbot-bytepatch/v1', entry['patch'])
            additions = b''.join(base64.b64decode(op[1]) for op in recipe['ops'] if op[0] == 'add')
            for token in forbidden:
                self.assertNotIn(token, additions, f'{entry["patch"]} contains {token!r}')

    def test_bot_id_injection_applies_to_the_complete_pinned_harness_target(self):
        source = pinned_host_archive('sand-host/sand-eval-runner.cjs')
        if source is None:
            self.skipTest('set ROKBOT_TEST_HOST_ARCHIVE to run the pinned Host recipe check')
        expected = {
            'recovered-core__stable__harness-turn-run-shell.mjs.gbp.gz': (
                '6baf0b160d518ab26d95cda8aa80657ea6c0ba5090317a3b69f5e0101b3c07e9', 1491, ()),
            'release-reliability__harness-turn-run-shell.mjs.gbp.gz': (
                '865a63d935c95d22cb11dd28b0b3980f47351ab654fc5f0300d61cf39ade9d0a', 1498, (870,)),
        }
        recipes = Path(__file__).resolve().parents[1] / 'recipes' / 'host'
        for name, (digest, lines, positions) in expected.items():
            with self.subTest(recipe=name):
                target = bytepatch.apply(source, bytepatch.load(recipes / name))
                self.assertEqual(bytepatch.digest(target), digest)
                target_lines = target.splitlines()
                self.assertEqual(len(target_lines), lines)
                found = tuple(index + 1 for index, line in enumerate(target_lines)
                              if b'agentId: host.getConversationId()' in line)
                self.assertEqual(found, positions)


if __name__ == '__main__':
    unittest.main()
