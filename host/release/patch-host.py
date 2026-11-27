#!/usr/bin/env python3
"""Prepare the pinned Host locally from an original archive and COPY/ADD patches."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import time
import urllib.request
from bytepatch import PatchSource, file_digest, load

ROOT = Path(__file__).resolve().parents[1]


def extract(source, destination):
    with tarfile.open(source) as archive:
        entries = archive.getmembers()
        if sum(max(0, entry.size) for entry in entries) > 512 * 1024 * 1024:
            raise ValueError('Host archive is too large')
        for entry in entries:
            path = Path(entry.name)
            if path.is_absolute() or '..' in path.parts or not (entry.isfile() or entry.isdir()):
                raise ValueError('Unsafe Host archive entry')
        for entry in entries:
            target = destination / entry.name
            if entry.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(entry) as src, target.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod(entry.mode & 0o777)


def verify_reliability_manifest(seed):
    """Reject generated reliability seeds whose manifest no longer matches them."""
    directory = seed / 'release-reliability'
    manifest_path = directory / 'manifest.json'
    if not manifest_path.exists():
        return
    manifest = json.loads(manifest_path.read_text())
    digest = manifest.get('digest')
    if not isinstance(digest, str) or len(digest) != 64:
        raise ValueError('Invalid prepared reliability manifest digest')
    files = manifest.get('files')
    if not isinstance(files, list):
        raise ValueError('Invalid prepared reliability manifest files')
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {'name', 'sha256'}:
            raise ValueError('Invalid prepared reliability manifest entry')
        name, expected = entry['name'], entry['sha256']
        if not isinstance(name, str) or Path(name).name != name or not isinstance(expected, str) or len(expected) != 64:
            raise ValueError('Invalid prepared reliability manifest entry')
        actual = hashlib.sha256((directory / name).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError('Prepared reliability manifest mismatch: ' + name)


def load_manifest(revision=None):
    recipes_root = ROOT / 'recipes/host'
    if revision:
        primary = json.loads((recipes_root / 'manifest.json').read_text())
        if revision == primary['archive']['version']:
            return recipes_root, primary
        fallback = (primary.get('fallback') or {}).get(revision)
        if not fallback or not isinstance(fallback.get('manifest'), str):
            raise ValueError(f'Unsupported Host revision: {revision}')
        manifest_path = (recipes_root / fallback['manifest']).resolve()
        if recipes_root.resolve() not in manifest_path.parents or not manifest_path.is_file():
            raise ValueError(f'Invalid fallback Host manifest: {revision}')
        return manifest_path.parent, json.loads(manifest_path.read_text())
    return recipes_root, json.loads((recipes_root / 'manifest.json').read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, help='User-provided stable Host archive; otherwise download the pinned URL')
    parser.add_argument('--revision', help='Pinned Host revision to apply (defaults to the primary manifest revision; supports documented fallbacks)')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output exists; select a new directory')
    recipes_dir, spec = load_manifest(args.revision)
    started = time.monotonic()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='rokbot-host-', dir=args.output.parent) as temporary:
        work = Path(temporary)
        archive = args.archive
        if not archive:
            archive = work / 'host.tgz'
            archive_url = os.environ.get('ROKBOT_HOST_ARCHIVE_URL') or os.environ.get('GROKBOT_HOST_ARCHIVE_URL') or spec['archive']['url']
            with urllib.request.urlopen(archive_url, timeout=60) as response, archive.open('wb') as target:
                shutil.copyfileobj(response, target)
        if file_digest(archive) != spec['archive']['sha256']:
            raise ValueError('Unsupported original Host archive: SHA-256 mismatch')
        download_seconds = time.monotonic() - started
        extract(archive, work / 'original')
        original = work / 'original' / 'sand-host'
        if (original / 'version').read_text().strip() != spec['archive']['version']:
            raise ValueError('Pinned Host revision does not match the archive')
        source_cache = {}
        seed = work / 'seed'
        for record in spec['files']:
            source_path = Path(record['source'])
            target_path = Path(record['target'])
            if any(p.is_absolute() or '..' in p.parts for p in (source_path, target_path)):
                raise ValueError('Unsafe patch path')
            if record['source'] not in source_cache:
                source_cache[record['source']] = PatchSource((original / source_path).read_bytes())
                if source_cache[record['source']].sha256 != spec['sourceSha256'][record['source']]:
                    raise ValueError('Pinned Host source digest mismatch: ' + record['source'])
            source = source_cache[record['source']]
            target = seed / target_path
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                source.write_verified(load(recipes_dir / record['patch']), output)
        verify_reliability_manifest(seed)
        args.output.mkdir(mode=0o700)
        shutil.move(str(original), str(args.output / 'original'))
        shutil.move(str(seed), str(args.output / 'seed'))
        report = dict(schema='rokbot-host-patch/v1', archiveSha256=spec['archive']['sha256'],
                      files=len(spec['files']), inputSeconds=round(download_seconds, 3),
                      patchSeconds=round(time.monotonic()-started-download_seconds, 3), originalPreserved=True)
        (args.output / 'patch-report.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(report))


if __name__ == '__main__':
    main()
