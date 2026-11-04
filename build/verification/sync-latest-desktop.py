"""Synchronize only shipped application files; preserve local browser profiles."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
import build_desktop
app = root / 'dist' / 'AvatarPrinter'
stage = root / 'build' / 'window-shell-dist' / 'AvatarPrinter'
manifest_path = app / 'build-manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))


def copy_changed(source, target):
    if target.is_file() and hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256(target.read_bytes()).digest():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


updates = json.loads((root / 'build' / 'ui-update-files.json').read_text(encoding='utf-8'))
updates += ['app/' + name for name in build_desktop.collector_resources()]
updates = list(dict.fromkeys(updates))
for relative in updates:
    assert relative.startswith('app/') and '..' not in Path(relative).parts
    source = root / relative.removeprefix('app/')
    target = app / relative
    assert source.is_file(), source
    target.parent.mkdir(parents=True, exist_ok=True)
    copy_changed(source, target)
copy_changed(stage / 'AvatarPrinter.exe', app / 'AvatarPrinter.exe')
for source in (stage / '_internal').rglob('*'):
    if source.is_file():
        copy_changed(source, app / source.relative_to(stage))
changed = updates + ['AvatarPrinter.exe'] + [
    file.relative_to(stage).as_posix()
    for file in (stage / '_internal').rglob('*') if file.is_file()
]
for relative in changed:
    manifest['files'][relative] = hashlib.sha256((app / relative).read_bytes()).hexdigest()
manifest['collector'] = {'mode': 'lightweight', 'upstream': 'ymstar/dyhub',
                         'commit': '21251a1150b7320abaac7ab8222cfa6856abcee2',
                         'nodeDependencies': build_desktop.NODE_RUNTIME_PACKAGES}
manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps({'synchronized': len(changed), 'resource_files': len(updates),
                  'exe_sha256': manifest['files']['AvatarPrinter.exe']}))
