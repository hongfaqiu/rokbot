import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

HOST = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HOST))
import deploy
import platforms

spec = importlib.util.spec_from_file_location('builder', HOST / 'release/build-docker.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

patch_spec = importlib.util.spec_from_file_location('patch_host', HOST / 'release/patch-host.py')
patch_host = importlib.util.module_from_spec(patch_spec)
patch_spec.loader.exec_module(patch_host)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.args = ['--home', str(self.home)]

    def invoke(self, *args):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            deploy.main(self.args + list(args))
        return out.getvalue()

    def test_platforms(self):
        for arch in ('amd64', 'x86_64', 'arm64', 'aarch64'):
            self.assertEqual(platforms.host_platform('Linux', arch), 'linux/' + ('arm64' if arch in ('arm64', 'aarch64') else 'amd64'))
        for os_name, arch in [('windows', 'amd64'), ('linux', 'armv7l')]:
            with self.assertRaises(ValueError): platforms.host_platform(os_name, arch)

    def test_runtime_matrix(self):
        for mode in (True, False):
            self.assertEqual(builder.choose_runtime('linux/amd64', mode), (platforms.BOX['localTag'], True))
            image, needs_box = builder.choose_runtime('linux/arm64', mode)
            self.assertNotEqual(image, platforms.BOX['localTag']); self.assertEqual(needs_box, not mode)

    def test_arm_probe_precedes_download(self):
        with patch.object(sys, 'argv', ['build']), patch.object(builder, 'docker_platform', return_value='linux/arm64'), \
             patch.object(builder, 'check_box_execution', side_effect=ValueError('no emulator')), patch.object(builder, 'prepare_box') as box:
            with self.assertRaisesRegex(ValueError, 'no emulator'): builder.main()
            box.assert_not_called()

    def test_arm_remote_skips_box_and_emulator(self):
        with patch.object(sys, 'argv', ['build', '--host-only', '--host-archive', str(self.home / 'missing')]), \
             patch.object(builder, 'docker_platform', return_value='linux/arm64'), patch.object(builder, 'check_box_execution') as probe, \
             patch.object(builder, 'prepare_box') as box:
            with self.assertRaises(FileNotFoundError): builder.main()
            box.assert_not_called(); probe.assert_not_called()

    def test_init_once_and_mode(self):
        self.invoke('--host-only', '--project', 'mybot', 'init', '--listen', '::1', '--public-url', 'http://[::1]:18080')
        env = (self.home / '.env').read_text()
        self.assertIn('ROKBOT_LISTEN_ADDRESS=[::1]', env)
        self.assertIn('ROKBOT_MODE=remote', env)
        self.assertIn('ROKBOT_PROJECT=mybot', env)
        with self.assertRaisesRegex(ValueError, 'never overwrites'): self.invoke('init')
        self.assertEqual(env, (self.home / '.env').read_text())
        with patch.object(deploy, 'run') as run: self.invoke('status')
        self.assertIn('mybot', run.call_args.args[0]); self.assertIn(str(deploy.RELEASE / 'compose.host.yaml'), run.call_args.args[0])
        with self.assertRaisesRegex(ValueError, 'Project name conflicts'): self.invoke('--project', 'other', 'status')

    def env(self):
        return dict(line.split('=', 1) for line in (self.home / '.env').read_text().splitlines())

    def test_init_gives_the_web_client_its_own_port_and_address(self):
        created = json.loads(self.invoke('init'))
        self.assertEqual(self.env()['ROKBOT_WEB_PUBLIC_PORT'], '18081')
        self.assertNotIn('ROKBOT_WEB_PUBLIC_URL', self.env())
        self.assertEqual(created['webClientUrl'], 'http://127.0.0.1:18081/web/')
        (self.home / '.env').unlink()
        self.invoke('init', '--port', '18082')
        self.assertEqual(self.env()['ROKBOT_WEB_PUBLIC_PORT'], '18083')
        (self.home / '.env').unlink()
        created = json.loads(self.invoke('init', '--listen', '0.0.0.0', '--public-url', 'https://bot.example.org',
                                         '--web-public-url', 'https://web.bot.example.org/'))
        self.assertEqual(self.env()['ROKBOT_WEB_PUBLIC_URL'], 'https://web.bot.example.org')
        self.assertEqual(created['webClientUrl'], 'https://web.bot.example.org/web/')

    def test_init_refuses_a_web_client_on_the_admin_origin(self):
        for flags in (['--web-port', '18080'], ['--web-port', '0'], ['--port', '65535'],
                      ['--public-url', 'https://bot.example.org', '--web-public-url', 'https://BOT.example.org:443'],
                      ['--public-url', 'https://bot.example.org', '--web-port', '443'],
                      ['--web-public-url', 'https://web.example.org/web']):
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                self.invoke('init', *flags)
        self.assertFalse((self.home / '.env').exists())

    def test_web_client_address_of_an_instance_from_an_earlier_release(self):
        (self.home / '.env').write_text('ROKBOT_LISTEN_ADDRESS=192.0.2.10\nROKBOT_PUBLIC_PORT=18080\n'
                                        'ROKBOT_PUBLIC_URL=http://192.0.2.10:18080\nROKBOT_MODE=local\n')
        with patch.dict('os.environ', {}):
            for key in deploy.WEB_SETTINGS:
                deploy.os.environ.pop(key, None)
            self.assertEqual(deploy.web_client_url(deploy.instance_env(self.home)), 'http://192.0.2.10:18081/web/')
            with contextlib.redirect_stderr(io.StringIO()) as notice:
                deploy.web_notice(self.home)
            self.assertIn('http://192.0.2.10:18081/web/', notice.getvalue())
            self.assertNotIn('reverse proxy', notice.getvalue())
            deploy.os.environ['ROKBOT_WEB_PUBLIC_URL'] = 'https://web.example.org'
            self.assertEqual(deploy.web_client_url(deploy.instance_env(self.home)), 'https://web.example.org/web/')
            del deploy.os.environ['ROKBOT_WEB_PUBLIC_URL']
            (self.home / '.env').write_text('ROKBOT_PUBLIC_URL="https://bot.example.org"\n')
            with contextlib.redirect_stderr(io.StringIO()) as notice:
                deploy.web_notice(self.home)
            self.assertIn('https://bot.example.org:18081/web/', notice.getvalue())
            self.assertIn('ROKBOT_WEB_PUBLIC_URL', notice.getvalue())
            deploy.check_web_address(self.home)
            (self.home / '.env').write_text('ROKBOT_PUBLIC_URL=https://bot.example.org\n'
                                            "ROKBOT_WEB_PUBLIC_URL='https://BOT.example.org:443/'\n")
            with self.assertRaisesRegex(ValueError, 'must differ from ROKBOT_PUBLIC_URL'):
                deploy.check_web_address(self.home)
            (self.home / '.env').write_text('ROKBOT_PUBLIC_URL=https://bot.example.org\n'
                                            'ROKBOT_WEB_PUBLIC_URL=https://web.bot.example.org\n')
            deploy.check_web_address(self.home)

    def test_ports_published_by_another_instance_are_refused_before_anything_changes(self):
        config = {'services': {'host': {'ports': [{'published': '18080', 'target': 8000},
                                                  {'published': '18081', 'target': 8001}]}, 'box': {}}}
        def docker(cmd, **kwargs):
            if cmd[-3:] == ['config', '--format', 'json']:
                return SimpleNamespace(stdout=json.dumps(config))
            if cmd[:2] == ['docker', 'ps']:
                return SimpleNamespace(stdout='other\n' if cmd[-1] == 'publish=18081' else 'own\n')
            raise AssertionError(cmd)
        with patch.object(deploy, 'run', side_effect=docker), \
             patch.object(deploy.volume_backup, 'project_ids', return_value=['own']):
            with self.assertRaisesRegex(ValueError, 'Port 18081 of host is already published'):
                deploy.check_free_ports(['docker', 'compose'], 'demo', True)
            config['services']['host']['ports'].pop()
            deploy.check_free_ports(['docker', 'compose'], 'demo', True)
            config['services']['host']['ports'] = [{'published': '18081', 'target': 8000},
                                                   {'published': '18081', 'target': 8001}]
            with self.assertRaisesRegex(ValueError, 'Port 18081 is published twice'):
                deploy.check_free_ports(['docker', 'compose'], 'demo', True)

    def test_a_port_held_by_a_program_outside_docker_is_refused(self):
        with socket.socket() as holder:
            holder.bind(('127.0.0.1', 0))
            holder.listen()
            port = str(holder.getsockname()[1])
            config = {'services': {'host': {'ports': [{'published': port, 'target': 8001, 'host_ip': '127.0.0.1'}]}}}
            published = ''
            def docker(cmd, **kwargs):
                if cmd[-3:] == ['config', '--format', 'json']:
                    return SimpleNamespace(stdout=json.dumps(config))
                if cmd[:2] == ['docker', 'ps']:
                    return SimpleNamespace(stdout=published)
                raise AssertionError(cmd)
            with patch.object(deploy, 'run', side_effect=docker), \
                 patch.object(deploy.volume_backup, 'project_ids', return_value=['own']):
                with self.assertRaisesRegex(ValueError, f'Port {port} of host is already in use by another program'):
                    deploy.check_free_ports(['docker', 'compose'], 'demo', True)
                published = 'own\n'
                deploy.check_free_ports(['docker', 'compose'], 'demo', True)
                published = ''
                holder.close()
                deploy.check_free_ports(['docker', 'compose'], 'demo', True)

    def test_legacy_prokbot_env_markers_and_default_project(self):
        (self.home / '.env').write_text('PROKBOT_MODE=remote\nPROKBOT_PROJECT=legacyproj\n', encoding='utf-8')
        with patch.object(deploy, 'run') as run:
            self.invoke('status')
        cmd = run.call_args.args[0]
        self.assertIn('legacyproj', cmd)
        self.assertIn(str(deploy.RELEASE / 'compose.host.yaml'), cmd)
        empty_home = self.home / 'empty'
        empty_home.mkdir()
        parsed = SimpleNamespace(host_only=False, project=None)
        deploy.instance_settings(parsed, empty_home)
        self.assertEqual(parsed.project, 'rokbot')

    def test_compose_default_machine_id_is_empty_with_legacy_fallback(self):
        compose_text = (HOST / 'release/compose.yaml').read_text(encoding='utf-8')
        self.assertIn('ROKBOT_DEFAULT_MACHINE_ID: ${ROKBOT_DEFAULT_MACHINE_ID:-${GROKBOT_DEFAULT_MACHINE_ID:-}}', compose_text)
        self.assertIn('name: rokbot', compose_text)

    def test_host_archive_url_mirror_override_enforces_sha256(self):
        bad_bytes = b'not-the-pinned-host-archive'
        class FakeResponse(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): return False
        for env_key in ('ROKBOT_HOST_ARCHIVE_URL', 'GROKBOT_HOST_ARCHIVE_URL'):
            with self.subTest(env_key=env_key), \
                 patch.dict(os.environ, {env_key: 'https://mirror.example.invalid/host.tgz'}, clear=False), \
                 patch.object(sys, 'argv', ['build', '--host-only']), \
                 patch.object(builder, 'docker_platform', return_value='linux/amd64'), \
                 patch.object(builder, 'check_box_execution'), \
                 patch.object(builder, 'prepare_box', return_value=builder.BOX_ID), \
                 patch.object(builder.urllib.request, 'urlopen', return_value=FakeResponse(bad_bytes)) as urlopen:
                with self.assertRaisesRegex(ValueError, 'SHA-256'):
                    builder.main()
                self.assertEqual(urlopen.call_args.args[0], 'https://mirror.example.invalid/host.tgz')
        with patch.dict(os.environ, {'ROKBOT_HOST_ARCHIVE_URL': 'https://mirror.example.invalid/host.tgz'}, clear=False), \
             patch.object(sys, 'argv', ['patch', '--output', str(self.home / 'patched')]), \
             patch.object(patch_host.urllib.request, 'urlopen', return_value=FakeResponse(bad_bytes)) as urlopen:
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                patch_host.main()
            self.assertEqual(urlopen.call_args.args[0], 'https://mirror.example.invalid/host.tgz')

    def test_box_image_mirror_override_enforces_identity(self):
        mirror = 'ghcr.io/hongfaqiu/rokbot/box:pinned'
        with patch.dict(os.environ, {'ROKBOT_BOX_IMAGE': mirror}, clear=False), \
             patch.object(builder, 'image_id', side_effect=lambda ref: builder.BOX_ID if ref == mirror else None), \
             patch.object(builder, 'run') as run:
            self.assertEqual(builder.prepare_box(None), builder.BOX_ID)
            run.assert_called_once_with('docker', 'tag', mirror, builder.BOX_TAG)
        with patch.dict(os.environ, {'GROKBOT_BOX_IMAGE': 'mirror.invalid/bad:tag'}, clear=False), \
             patch.object(builder, 'image_id', side_effect=lambda ref: 'sha256:' + 'f' * 64 if ref == 'mirror.invalid/bad:tag' else None), \
             patch.object(builder, 'run'):
            with self.assertRaisesRegex(ValueError, 'Unsupported Box image identity'):
                builder.prepare_box(None)

    def test_invalid_url_writes_nothing(self):
        for url in ['http://bot/path', 'http://user@bot', 'https://bot:65536', 'http://bot?key=x', 'https://bot:0']:
            with self.assertRaises(ValueError): self.invoke('init', '--public-url', url)
        self.assertFalse((self.home / '.env').exists())

    def test_preflight_failure_is_json(self):
        with patch.object(deploy, 'docker_platform', side_effect=ValueError('unsupported')), contextlib.redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(SystemExit) as failure: deploy.main(self.args + ['doctor'])
            self.assertEqual(failure.exception.code, 1); self.assertFalse(json.loads(out.getvalue())['ok'])

    def test_archive_flags_keep_pinned_build_path(self):
        archive = self.home / 'original.tgz'; archive.touch()
        args = SimpleNamespace(host_only=True, host_archive=archive, box_archive=None)
        with patch.object(deploy, 'run') as called: deploy.build(args, 'candidate')
        self.assertEqual(called.call_args.args[0][-3:], ['--host-only', '--host-archive', str(archive.resolve())])

    def test_web_bundle_flags_reach_the_image_build(self):
        bundle = self.home / 'web.zip'; bundle.touch()
        args = SimpleNamespace(host_only=False, host_archive=None, box_archive=None, web_source=None, web_bundle=bundle)
        with patch.object(deploy, 'run') as called: deploy.build(args, 'candidate')
        self.assertEqual(called.call_args.args[0][-2:], ['--web-bundle', str(bundle.resolve())])
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            deploy.main(self.args + ['update', '--web-source', 'a.exe', '--web-bundle', 'b.zip'])

    def test_web_bundle_is_copied_checked_and_optional(self):
        import zipfile
        self.assertIsNone(builder.web_bundle(self.home / 'none'))
        self.assertEqual(list((self.home / 'none').iterdir()), [], 'the image still gets an empty web-bundle/')
        good = self.home / 'RokBotLocal-web-1.2.3.zip'
        with zipfile.ZipFile(good, 'w') as archive:
            archive.writestr('web-bundle.json', '{}'); archive.writestr('client/bridge.js', '')
        digest = builder.web_bundle(self.home / 'web', good)
        self.assertEqual(digest, hashlib.sha256(good.read_bytes()).hexdigest())
        self.assertEqual((self.home / 'web/web.zip').read_bytes(), good.read_bytes())
        bad = self.home / 'other.zip'
        with zipfile.ZipFile(bad, 'w') as archive: archive.writestr('client/bridge.js', '')
        with self.assertRaisesRegex(ValueError, 'Not a web client bundle'): builder.web_bundle(self.home / 'bad', bad)
        dockerfile = (HOST / 'release/Dockerfile.host').read_text(encoding='utf-8')
        self.assertIn('COPY web/ web-bundle/', dockerfile)
        self.assertIn('dev.rokbot.web-bundle-sha256=${WEB_BUNDLE_SHA256}', dockerfile)

    def test_97658ad_release_containers_and_healthcheck_timeout(self):
        manifest = json.loads((HOST / 'recipes/host/manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['archive']['version'], '97658ad')
        self.assertEqual(manifest['box']['localTag'], 'rokbot-box-input:97658ad')
        self.assertIn('sand-eval-runner.cjs', manifest['sourceSha256'])
        dockerfile = (HOST / 'release/Dockerfile.host').read_text(encoding='utf-8')
        self.assertIn('ARG RUNTIME_IMAGE=rokbot-box-input:97658ad', dockerfile)
        self.assertIn('ROKBOT_ALLOW_DEVICE_MODEL_CONFIG=1', dockerfile)
        self.assertIn('ROKBOT_UPDATE_DIR=/data/updates', dockerfile)
        self.assertIn('--timeout=15s', dockerfile)
        self.assertNotIn('/opt/grokbot', dockerfile)
        self.assertNotIn('GROKBOT_RUNTIME_DIR', dockerfile)
        for rel in ('release/compose.yaml', 'release/compose.host.yaml'):
            text = (HOST / rel).read_text(encoding='utf-8')
            self.assertIn('timeout: 15s', text, rel)
        for rel in ('release/compose.yaml', 'release/compose.execution.yaml'):
            text = (HOST / rel).read_text(encoding='utf-8')
            self.assertIn('rokbot-box-input:97658ad', text, rel)


class ComposeMountTests(unittest.TestCase):
    dc = ['docker', 'compose', '-p', 'demo']
    image_id = 'sha256:' + '1' * 64

    @staticmethod
    def config(existing=False, box=False):
        specs = {'host': ('host:local', [('host-data', '/data')])}
        if box:
            specs['box'] = (deploy.BOX['localTag'], [('box-home', '/home/box'), ('box-workspace', '/workspace')])
        services, volumes = {}, {}
        for service, (image, pairs) in specs.items():
            services[service] = {'image': image, 'volumes': [
                {'type': 'volume', 'source': name, 'target': dest} for name, dest in pairs]}
            for name, _ in pairs:
                volumes[name] = {'name': 'demo_' + name}
                if existing:
                    volumes[name]['external'] = True
        return {'services': services, 'volumes': volumes}

    @contextlib.contextmanager
    def config_only(self, config, existing, pinned=None):
        def read(cmd, **kwargs):
            self.assertEqual(cmd, self.dc + ['config', '--format', 'json'])
            self.assertTrue(kwargs['capture'])
            env = kwargs['env']
            self.assertEqual(env['ROKBOT_EXISTING_VOLUMES'], 'true' if existing else 'false')
            for service, image in (pinned or {}).items():
                self.assertEqual(env['ROKBOT_' + service.upper() + '_IMAGE'], image)
            return SimpleNamespace(stdout=json.dumps(config))

        with patch.object(deploy, 'run', side_effect=read) as run, \
             patch('subprocess.Popen', side_effect=AssertionError('Unexpected external process')):
            try:
                yield
            finally:
                run.assert_called_once()

    def images(self, config, existing=False):
        with self.config_only(config, existing):
            return deploy.instance_images(self.dc, 'demo', tuple(config['services']), existing)

    def test_supported_mounts_and_non_overlapping_tmpfs(self):
        for box in (False, True):
            for existing in (False, True):
                with self.subTest(box=box, existing=existing):
                    config = self.config(existing, box)
                    services = config['services']
                    images = {s: v['image'] for s, v in services.items()}
                    self.assertEqual(self.images(config, existing), images)
                    services['host']['volumes'].insert(0, {'type': 'tmpfs', 'target': '/database'})
                    services['host']['tmpfs'] = '/run:mode=0700'
                    if box:
                        services['box']['volumes'].reverse()
                        services['box']['tmpfs'] = ['/home/box-old', '/run:mode=0700']
                    self.assertEqual(self.images(config, existing), images)

    def test_rejects_extra_duplicate_and_shadowing_mounts(self):
        cases = [('host', 'bind', '/fixture', '/logs'), ('host', 'volume', 'extra', '/logs'),
                 ('host', 'volume', None, '/scratch'), ('host', 'volume', 'host-data', '/copy'),
                 ('host', 'volume', 'host-data', '/data'), ('host', 'bind', '/fixture', '/data'),
                 ('host', 'volume', 'extra', '/data/uploads'), ('box', 'bind', '/fixture', '/workspace/logs'),
                 ('host', 'tmpfs', None, '/'), ('box', 'tmpfs', None, '/home'),
                 ('host', 'tmpfs', None, '//data/.'), ('host', 'tmpfs', None, '/scratch/../data/cache')]
        for service, kind, source, target in cases:
            with self.subTest(service=service, kind=kind, target=target):
                config = self.config(box=True)
                mount = {'type': kind, 'target': target}
                if source is not None:
                    mount['source'] = source
                if source == 'extra':
                    config['volumes'][source] = {'name': 'demo_extra'}
                config['services'][service]['volumes'].append(mount)
                with self.assertRaisesRegex(ValueError, service):
                    self.images(config)

    def test_checks_mounts_outside_service_volumes_list(self):
        for key, value in [('tmpfs', '/data:mode=0700'), ('tmpfs', ['/data/cache:size=64k']),
                           ('tmpfs', ['/run/.:mode=0700']), ('volumes_from', ['container:peer']),
                           ('configs', [{'source': 'cfg', 'target': '/data/cfg'}]),
                           ('secrets', [{'source': 'key'}]), ('use_api_socket', True)]:
            with self.subTest(key=key, value=value):
                config = self.config()
                config['services']['host']['volumes'].append({'type': 'tmpfs', 'target': '/run'})
                config['services']['host'][key] = value
                if key in ('configs', 'secrets'):
                    config[key] = {value[0]['source']: {'file': '/fixture'}}
                with self.assertRaisesRegex(ValueError, 'host'):
                    self.images(config)

    def test_required_volume_is_still_exact_and_writable(self):
        for mount, volume in [(None, {}), ({'source': 'other'}, {}), ({'read_only': True}, {}),
                              ({'type': 'tmpfs'}, {}), ({}, {'name': 'other_host-data'}), ({}, {'external': True})]:
            with self.subTest(mount=mount, volume=volume):
                config = self.config()
                mounts = config['services']['host']['volumes']
                if mount is None:
                    mounts.clear()
                else:
                    mounts[0].update(mount)
                config['volumes']['host-data'].update(volume)
                with self.assertRaisesRegex(ValueError, '/data'):
                    self.images(config)

    def test_existing_volume_subdirectory_is_not_the_managed_data_root(self):
        for service, expected in [('host', '/data'), ('box', '/home/box')]:
            with self.subTest(service=service):
                config = self.config(existing=True, box=True)
                mount = config['services'][service]['volumes'][0]
                mount['volume'] = {'nocopy': True}
                self.assertIn(service, self.images(config, existing=True))
                mount['volume']['subpath'] = 'other-instance'
                with self.assertRaisesRegex(ValueError, expected):
                    self.images(config, existing=True)

    def test_new_install_and_update_reject_before_inventory(self):
        for action in ('up', 'update'):
            with self.subTest(action=action):
                existing = action == 'update'
                config = self.config(existing)
                config['services']['host']['tmpfs'] = ['/data/cache']
                args = SimpleNamespace(action=action, host_only=True, project='demo')
                with self.config_only(config, existing), patch.object(deploy, 'inventory') as inventory:
                    with self.assertRaisesRegex(ValueError, '/data/cache'):
                        deploy.operate(args, None, self.dc)
                    inventory.assert_not_called()

    def test_last_preflight_rejects_before_compose_up(self):
        images = {'host': self.image_id}
        for existing in (False, True):
            with self.subTest(existing=existing):
                config = self.config(existing)
                config['services']['host'].update(image=self.image_id, tmpfs=['/data/cache'])
                with self.config_only(config, existing, images), self.assertRaisesRegex(ValueError, '/data/cache'):
                    deploy.up_and_wait(self.dc, 'demo', ('host',), images, existing=existing)

    def test_post_build_preflight_rejects_before_stop_or_backup(self):
        config = self.config(existing=True)
        config['services']['host']['tmpfs'] = ['/data/cache']
        old = {'host': {'Id': 'original', 'Image': self.image_id, 'State': {'Status': 'running'}}}
        staged = contextlib.nullcontext({'host': 'sha256:' + '2' * 64})
        with self.config_only(config, True), patch.object(deploy, 'tag_state', return_value=self.image_id), \
             patch.object(deploy, 'image_id', return_value=self.image_id), patch.object(deploy, 'staged_host', return_value=staged), \
             patch.object(deploy, 'inventory', return_value=old), patch.object(deploy, 'backup') as backup:
            with self.assertRaisesRegex(ValueError, '/data/cache'):
                deploy.upgrade(SimpleNamespace(project='demo'), None, self.dc, ('host',), 'host:local', old, 'demo', False)
            backup.assert_not_called()

    def test_recovery_preflight_rejects_before_writing_volumes(self):
        config = self.config(existing=True)
        config['services']['host'].update(image=self.image_id, tmpfs=['/data/cache'])
        images = {'host': self.image_id}
        manifest = {'project': 'original', 'serviceImages': images, 'volumes': [{'suffix': 'host-data'}]}
        args = SimpleNamespace(project='demo', directory=Mock(spec=Path))
        with self.config_only(config, True, images), patch.object(deploy.volume_backup, 'read_manifest', return_value=manifest), \
             patch.object(deploy, 'image_id', return_value=self.image_id), patch.object(deploy, 'check_platform'), \
             patch.object(deploy.volume_backup, 'restore') as restore:
            with self.assertRaisesRegex(ValueError, '/data/cache'):
                deploy.recover(args, None, self.dc, ('host',))
            restore.assert_not_called()


if __name__ == '__main__':
    unittest.main()
