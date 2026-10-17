"""Collect completed local runtime proofs without including credentials or game files."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
import shutil
from datetime import datetime, timezone

root = Path(__file__).resolve().parent.parent
destination = root / 'verification'
destination.mkdir(exist_ok=True)
inventory = []

def copy(source: Path, relative: str):
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    inventory.append({'file': relative, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes': target.stat().st_size})

for name, report in [
    ('native-flow', 'work/native-flow/evidence.json'),
    ('native-stage', 'work/native-stage-final/evidence.json'),
    ('protocol-player', 'work/player-live/evidence.json'),
    ('map-viewer', 'work/viewer-qa/evidence/result.json'),
    ('modern-anvil', 'work/anvil-modern-proof/verification.json'),
    ('legacy-audit', 'work/fabric-runtime-legacy/expanded/audit.json'),
    ('file-stage-client', 'work/file-stage-client/evidence.json'),
    ('resource-preview', 'work/resource-preview-qa/evidence.json'),
    ('animated-resource-preview-26.3', 'work/rendering-26.3/evidence.json'),
    ('free-entity-import-26.3', 'work/entity-stage-proof/evidence.json'),
    ('christmas-native-view-26.3', 'work/christmas-qa/final-native-evidence.json'),
]:
    copy(root / report, f'{name}/report.json')

for name, directory in [
    ('native-flow', 'work/native-flow/artifacts'),
    ('native-stage', 'work/native-stage-final/artifacts'),
    ('protocol-player', 'work/player-live/artifacts'),
    ('map-viewer', 'work/viewer-qa/evidence'),
    ('file-stage-client', 'work/file-stage-client/captures'),
    ('resource-preview', 'work/resource-preview-qa/artifacts'),
    ('animated-resource-preview-26.3', 'work/rendering-26.3'),
]:
    for source in sorted((root / directory).glob('*')):
        if source.is_file() and source.suffix in ('.png', '.json') and source.name != 'result.json':
            copy(source, f'{name}/{source.name}')

test_text = (root / 'work/final-tests.log').read_text(encoding='utf-8-sig')
def count(label):
    matches = re.findall(rf'^.*?\b{label}\s+(\d+)\s*$', test_text, re.MULTILINE)
    if not matches:
        raise SystemExit(f'Missing final test count: {label}')
    return int(matches[-1])
test_counts = {'total': count('tests'), 'passed': count('pass'), 'failed': count('fail'), 'optInLiveSkippedInDefaultSuite': count('skipped')}
if test_counts['failed'] or not test_counts['passed']:
    raise SystemExit('Final automated tests have not passed')
copy(root / 'work/final-tests.log', 'automated-tests.txt')
matrix = json.loads((root / 'bridges/fabric/compatibility.json').read_text(encoding='utf-8-sig'))
doctor = json.loads((root / 'work/final-doctor.json').read_text(encoding='utf-8-sig'))['result']
summary = {
    'release': json.loads((root / 'package.json').read_text(encoding='utf-8'))['version'],
    'verifiedAt': datetime.now(timezone.utc).isoformat(),
    'node': doctor['node'],
    'automatedTests': test_counts,
    'minecraft': {
        'latestReleaseAtVerification': doctor['latestRelease'],
        'targetVersions': doctor['targetVersions'],
        'exactFabricJarsBuilt': sum(bool(v['compiled']) for v in matrix['versions']),
        'matchingVanillaRuntimeVerified': matrix['runtimeVerifiedCount'],
        'acceptancePolicy': 'User requested representative 26.3 testing and stopped the remaining full-version runtime matrix.',
        'representativeVersion': '26.3',
        'unverifiedCurrentArtifacts': [v['version'] for v in matrix['versions'] if not v.get('runtimeVerified')],
        'coreScenariosPerVersion': ['connect', 'observe', 'move', 'command', 'interact', 'capture', 'cancel'],
        'offlineCollisionRegistry': '../bridges/fabric/collision-data/index.json',
        'matrix': '../bridges/fabric/compatibility.json',
    },
    'integratedProofs': {
        'nativeInteriorNavigationTour26_3': 'native-flow/report.json',
        'copiedWorldExactRendererOriginal33FilesUnchanged': 'native-stage/report.json',
        'realMineflayer1_21_4': 'protocol-player/report.json',
        'interactiveStructuralPreview': 'map-viewer/report.json',
        'modernWorldLayoutAndPalette26_3': 'modern-anvil/report.json',
        'blockbench': '../bridges/blockbench/evidence/README.md',
        'portableFileNativeStages': 'file-stage-client/report.json',
        'zipResourcePackActualPixels': 'resource-preview/report.json',
        'paperAndCancellation': '../docs/evidence/servers/README.md',
        'animatedTexturesWithInterpolation26_3': 'animated-resource-preview-26.3/report.json',
        'freeEntitiesPassengersRichTextRetry26_3': 'free-entity-import-26.3/report.json',
        'exactLiveBrowserAndCollisionAcquisition26_3': 'christmas-native-view-26.3/report.json',
    },
    'scope': [
        'Fabric runtime scenarios used isolated offline test profiles and matching Vanilla servers, not user accounts or arbitrary mod packs.',
        'Java resource-model and Mineflayer previews are approximate; Fabric captures the actual game framebuffer.',
        'Blockbench 4.12.6 and 5.2.2 use real CLI file transport and actual native codec/renderer; no fixture filesystem adapter or Blockbench filesystem permission is required.',
        'Raw evidence keeps historical absolute paths. Inventory filenames below are portable relative to this directory.',
    ],
    'files': inventory,
}
(destination / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'directory': str(destination), 'files': len(inventory), 'bytes': sum(f['bytes'] for f in inventory)}, indent=2))
