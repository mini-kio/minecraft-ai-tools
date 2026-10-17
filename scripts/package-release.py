"""Package project code and companion JARs; exclude accounts, downloaded games and test worlds."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True, help='Destination ZIP file')
parser.add_argument('--representative-version', default='26.3', help='User-selected runtime acceptance target')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
output = Path(args.output).resolve()
matrix = json.loads((root / 'bridges/fabric/compatibility.json').read_text(encoding='utf-8-sig'))
versions = matrix['versions']
if len(versions) != 24 or not all(v.get('compiled') for v in versions):
    raise SystemExit('Release requires 24 exact-version compiled artifacts')
representative = next((v for v in versions if v['version'] == args.representative_version), None)
if not representative or not representative.get('runtimeVerified'):
    raise SystemExit('Representative runtime acceptance has not passed')
for version in versions:
    jar = root / version['artifact']
    if hashlib.sha256(jar.read_bytes()).hexdigest() != version['sha256']:
        raise SystemExit(f"JAR checksum mismatch: {version['version']}")
    with zipfile.ZipFile(jar) as archive:
        if any(name.startswith('net/minecraft/') and name.endswith('.class') for name in archive.namelist()):
            raise SystemExit('Companion archive must not contain Minecraft game classes')
    evidence = version.get('runtimeEvidence', {})
    for record, hash_key in ([(evidence, 'reportSha256')] if evidence else []) + [(item, 'sha256') for item in evidence.get('images', [])]:
        source = root / record['file']
        if hashlib.sha256(source.read_bytes()).hexdigest() != record[hash_key]:
            raise SystemExit(f'Evidence checksum mismatch: {source}')

summary = json.loads((root / 'verification/summary.json').read_text(encoding='utf-8-sig'))
if summary['automatedTests']['failed'] or set(summary['minecraft']['targetVersions']) != {v['version'] for v in versions}:
    raise SystemExit('Final test or version coverage gate failed')
for record in summary['files']:
    source = root / 'verification' / record['file']
    if hashlib.sha256(source.read_bytes()).hexdigest() != record['sha256']:
        raise SystemExit(f'Integrated evidence checksum mismatch: {source}')
collisions = json.loads((root / 'bridges/fabric/collision-data/index.json').read_text(encoding='utf-8'))
if args.representative_version not in {v['gameVersion'] for v in collisions['versions']}:
    raise SystemExit('Representative offline collision dataset is missing')
for item in collisions['versions']:
    source = root / 'bridges/fabric/collision-data' / item['file']
    artifact = next(v for v in versions if v['version'] == item['gameVersion'])
    if hashlib.sha256(source.read_bytes()).hexdigest() != item['sha256'] or artifact['sha256'] != item['artifactSha256']:
        raise SystemExit(f'Native collision export checksum or artifact mismatch: {source}')
server_evidence = root / 'docs/evidence/servers'
for item in json.loads((server_evidence / 'sha256.json').read_text(encoding='utf-8'))['files']:
    if hashlib.sha256((server_evidence / item['file']).read_bytes()).hexdigest() != item['sha256']:
        raise SystemExit(f'Server evidence checksum mismatch: {item["file"]}')
for folder in (root / 'bridges/blockbench/evidence').iterdir():
    if folder.is_dir():
        metadata = json.loads((folder / 'metadata.json').read_text(encoding='utf-8'))
        for item in metadata['files']:
            if hashlib.sha256((folder / item['file']).read_bytes()).hexdigest() != item['sha256']:
                raise SystemExit(f'Blockbench evidence checksum mismatch: {folder / item["file"]}')

files = []
top = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'README.md', 'LICENSE', '.gitignore', 'mct.cmd', 'mct.ps1']
for name in top:
    files.append(root / name)
excluded = {'node_modules', 'work', '.mct', '.gradle', 'build', '__pycache__', 'generated'}
for folder in ['src', 'dist', 'bin', 'bridges', 'scripts', 'tests', 'examples', 'docs', 'verification']:
    for source in (root / folder).rglob('*'):
        relative = source.relative_to(root)
        if source.is_file() and not excluded.intersection(relative.parts):
            files.append(source)
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=7) as archive:
    for source in sorted(set(files)):
        archive.write(source, Path('minecraft-ai-tools') / source.relative_to(root))
with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise SystemExit('ZIP integrity check failed')
    jars = [n for n in archive.namelist() if n.startswith('minecraft-ai-tools/bridges/fabric/dist/') and n.endswith('.jar')]
    if len(jars) != 24:
        raise SystemExit(f'Expected 24 companion JARs, got {len(jars)}')
print(json.dumps({'output': str(output), 'files': len(files), 'companionJars': len(jars), 'bytes': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}, indent=2))
