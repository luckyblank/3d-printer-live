"""Build a portable Windows desktop distribution from a clean virtual environment."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / 'build' / 'desktop'
DIST = ROOT / 'dist'
NAME = 'AvatarPrinter'
APP = DIST / NAME

# Only application resources are shipped. Browser profiles, audience caches,
# recorded sessions, tests and developer tools are never copied into the package.
PAGES = ('index.html', 'index-en.html', 'help.html', 'features.html', 'guide.html', 'live.html', 'live-view.html')
MODULES = (
    'bridge-ws.mjs', 'douyin-bridge.mjs', 'demo-rules.mjs', 'download-rules.mjs',
    'lightweight-session.mjs', 'douyin-wire.mjs', 'douyin-events.mjs', 'collector-runtime.mjs',
    'gift-speech.mjs', 'gift-speech-en.mjs', 'print-settings.mjs', 'printer-audio.mjs', 'audio-state.mjs',
    'render-budget.mjs', 'scene-channel.mjs', 'scene-output.mjs', 'scene-window-size.mjs',
    'workspace-ui.mjs', 'demo-panel.mjs', 'settings-panel.mjs', 'scene-window-model.mjs',
    'scene-window-settings.mjs', 'scene-window-view.mjs', 'scene-gift-icons.mjs', 'dynamic-hoses.mjs', 'avatar-assets.mjs', 'static-batching.mjs',
)
COLLECTOR_STATIC_RESOURCES = (
    'package.json', 'package-lock.json', 'THIRD-PARTY-NOTICES.md',
    'third_party/douyin-sign/sign.js', 'third_party/douyin-sign/a_bogus.js',
    'third_party/douyin-sign/LICENSE', 'third_party/douyin-sign/DYHUB-LICENSE',
    'third_party/douyin-sign/NOTICE.md', 'third_party/douyin-sign/UPSTREAM-README.md',
)
NODE_RUNTIME_PACKAGES = {'ws': '8.22.1', 'protobufjs': '8.8.1', 'long': '5.3.2'}


def collector_resources(root=ROOT):
    """Explicit production packages only; never discover profiles or credentials."""
    root = Path(root)
    result = list(COLLECTOR_STATIC_RESOURCES)
    lock = json.loads((root / 'package-lock.json').read_text(encoding='utf-8'))
    for name, version in NODE_RUNTIME_PACKAGES.items():
        package = root / 'node_modules' / name
        metadata = json.loads((package / 'package.json').read_text(encoding='utf-8'))
        if metadata['version'] != version or lock['packages']['node_modules/' + name]['version'] != version:
            raise ValueError(f'Runtime dependency version differs from lockfile: {name}')
        for item in sorted(package.rglob('*')):
            if item.is_symlink():
                raise ValueError(f'Linked runtime resource: {item}')
            if item.is_file():
                result.append(item.relative_to(root).as_posix())
    for name in result:
        if not (root / name).is_file():
            raise FileNotFoundError(name)
    return tuple(result)


def make_icon():
    from PIL import Image, ImageDraw
    image = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((8, 8, 248, 248), radius=48, fill='#111823')
    draw.rounded_rectangle((49, 47, 207, 67), radius=8, fill='#a9bdd0')
    draw.rounded_rectangle((49, 49, 67, 203), radius=6, fill='#a9bdd0')
    draw.rounded_rectangle((189, 49, 207, 203), radius=6, fill='#a9bdd0')
    draw.rounded_rectangle((104, 62, 152, 111), radius=9, fill='#ff765d')
    draw.polygon(((116, 111), (140, 111), (128, 128)), fill='#ffd5b3')
    draw.rounded_rectangle((91, 152, 165, 182), radius=12, fill='#67d9e5')
    draw.rounded_rectangle((75, 183, 181, 195), radius=5, fill='#71869a')
    draw.rounded_rectangle((39, 201, 217, 219), radius=8, fill='#a9bdd0')
    target = BUILD / 'printer.ico'
    image.save(target, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return target


def main():
    if sys.platform != 'win32':
        raise SystemExit('Build this Windows package on Windows.')
    import PyInstaller.__main__

    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js 22+ is required on the build machine.')
    version = subprocess.check_output([node, '--version'], text=True).strip()
    if int(version.lstrip('v').split('.')[0]) < 22:
        raise SystemExit('Node.js 22+ is required for the bridge WebSocket API.')
    node_license = Path(node).parent / 'LICENSE'
    if not node_license.is_file():
        raise SystemExit(f'Node.js distribution LICENSE missing: {node_license}')
    BUILD.mkdir(parents=True, exist_ok=True)
    DIST.mkdir(exist_ok=True)
    icon = make_icon()
    options = [
        str(ROOT / 'launch.py'), '--name', NAME, '--onedir', '--windowed',
        '--noconfirm', '--clean', '--noupx', '--icon', str(icon),
        '--distpath', str(DIST), '--workpath', str(BUILD / 'work'),
        '--specpath', str(BUILD), '--collect-data', 'webview',
        '--hidden-import', 'webview.platforms.winforms',
        '--hidden-import', 'webview.platforms.edgechromium',
    ]
    for module in ('PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'gi', 'gtk', 'cefpython3', 'webview.platforms.qt'):
        options += ['--exclude-module', module]
    PyInstaller.__main__.run(options)

    resources = APP / 'app'
    resources.mkdir(exist_ok=True)
    for name in (*PAGES, *MODULES, *collector_resources()):
        target = resources / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, target)
    shutil.copytree(ROOT / 'assets', resources / 'assets', dirs_exist_ok=True)
    (resources / 'docs').mkdir(exist_ok=True)
    shutil.copy2(ROOT / 'docs' / 'tutorial-cover.jpg', resources / 'docs' / 'tutorial-cover.jpg')
    if (ROOT / 'LICENSE').is_file():
        shutil.copy2(ROOT / 'LICENSE', APP / 'LICENSE.txt')
    runtime = APP / 'runtime'
    runtime.mkdir(exist_ok=True)
    shutil.copy2(node, runtime / 'node.exe')
    shutil.copy2(node_license, runtime / 'NODE-LICENSE.txt')
    licenses = APP / 'THIRD-PARTY-LICENSES'
    licenses.mkdir(exist_ok=True)
    for candidate in ('LICENSE_PYTHON.txt', 'LICENSE.txt'):
        python_license = Path(sys.base_prefix) / candidate
        if python_license.is_file():
            shutil.copy2(python_license, licenses / 'PYTHON-LICENSE.txt')
            break
    for name in ('pywebview', 'pythonnet', 'clr_loader', 'bottle', 'proxy_tools', 'cffi', 'pillow'):
        distribution = importlib.metadata.distribution(name)
        for item in distribution.files or ():
            if Path(item).name.lower().startswith(('license', 'copying')):
                target = licenses / name / Path(item).name
                target.parent.mkdir(exist_ok=True)
                shutil.copy2(distribution.locate_file(item), target)

    (APP / '使用说明.txt').write_text(
        '头像打印机 · Windows 桌面版\n\n'
        '1. 请先解压整个文件夹，再双击 AvatarPrinter.exe。\n'
        '2. 无需安装 Python 或 Node.js，请保留 app、runtime 和 _internal 文件夹。\n'
        '3. 支持 Windows 10 / 11（64 位），需要 Microsoft Edge WebView2 Runtime。\n'
        '   若系统未安装 WebView2，请从微软官网下载并安装：\n'
        '   https://developer.microsoft.com/microsoft-edge/webview2/\n'
        '4. 接入直播时填写房间号，点击登录抖音；成功后登录窗自动关闭，再开始后台抓取。\n'
        '5. 登录状态、镜头设置和缓存仅保存在本机。请把文件夹放到有写入权限的位置。\n'
        '6. 若打不开，请查看 app\\desktop-launch.log；数据桥日志为 app\\desktop-bridge.log。\n'
        '7. 此版本已去除页面广告、联系方式与署名水印。\n', encoding='utf-8-sig')
    manifest = {
        'application': NAME, 'platform': 'windows-x64', 'node': version,
        'dependencies': {name: importlib.metadata.version(name) for name in ('pywebview', 'pyinstaller', 'pillow', 'pythonnet')},
        'collector': {'mode': 'lightweight', 'upstream': 'ymstar/dyhub',
                      'commit': '21251a1150b7320abaac7ab8222cfa6856abcee2',
                      'nodeDependencies': NODE_RUNTIME_PACKAGES},
        'files': {},
    }
    for item in sorted(APP.rglob('*')):
        if item.is_file():
            manifest['files'][item.relative_to(APP).as_posix()] = hashlib.sha256(item.read_bytes()).hexdigest()
    (APP / 'build-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    archive = DIST / 'AvatarPrinter-Windows-x64.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for item in sorted(APP.rglob('*')):
            if item.is_file():
                output.write(item, item.relative_to(DIST))
    print(f'Built: {archive}\nSize: {archive.stat().st_size / 1024**2:.1f} MiB', flush=True)


if __name__ == '__main__':
    main()
