"""Verify both disk images, mounted signatures and every payload file after convert."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.verify_macos_build import snapshot


def verify_conversion(original, converted, out, *, command_runner=None):
    """Mac commands are injectable so failure/cleanup checks run on Linux."""
    run = command_runner or subprocess.run
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    mounted, commands, manifests = [], [], []
    result = dict(success=False)

    def command(args):
        commands.append(args)
        return run(args, check=True, capture_output=True, text=True, timeout=180)

    try:
        for label, image in (('original', original), ('converted', converted)):
            command(['/usr/bin/hdiutil', 'verify', str(image)])
            mount = out / (label + '.noindex')
            mount.mkdir()
            command(['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen',
                     '-mountpoint', str(mount), str(image)])
            mounted.append(mount)
            command(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(mount / 'FreeVideo.app')])
            manifest = snapshot(mount)
            (out / (label + '-files.json')).write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
            manifests.append(manifest)
        differences = [name for name in sorted(set(manifests[0]) | set(manifests[1]))
                       if manifests[0].get(name) != manifests[1].get(name)]
        if differences:
            result['differences'] = differences
            raise ValueError('Converted DMG payload differs from original')
        result.update(success=True, files=sum(row['kind'] == 'file' for row in manifests[0].values()),
                      images_verified=True, mounted_signatures_verified=True, payload_sha256_equal=True)
    except Exception as error:
        result['error'] = str(error)
    finally:
        for mount in reversed(mounted):
            try:
                command(['/usr/bin/hdiutil', 'detach', str(mount)])
            except Exception as error:
                result.update(success=False, detach_error=str(error))
        result['commands'] = commands
        (out / 'result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    build = json.loads((args.build / 'build-result.json').read_text(encoding='utf-8'))
    result = verify_conversion(build['original_dmg'], build['dmg'], args.out)
    print(json.dumps({key: value for key, value in result.items() if key != 'commands'}))
    raise SystemExit(not result['success'])


if __name__ == '__main__':
    main()
