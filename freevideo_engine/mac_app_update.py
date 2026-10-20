"""Replace the running FreeVideo.app with the one inside a downloaded DMG.

The DMG is checked and copied next to the running app while the old version
keeps working. Only the final swap waits for the old process to exit, and it
puts the old app back whenever any step of it fails."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time


MARK = '.FreeVideo-update-'
BACKUP = '.FreeVideo-backup-'
MARGIN_BYTES = 256 * 2**20
HDIUTIL, DITTO, CODESIGN, XATTR = '/usr/bin/hdiutil', '/usr/bin/ditto', '/usr/bin/codesign', '/usr/bin/xattr'

# Plain sh, so the swap does not depend on anything inside the app it replaces.
SWAP_SCRIPT = r'''#!/bin/sh
pid="$1"; app="$2"; staged="$3"; backup="$4"; failure="$5"; inject="$6"
opener="${FREEVIDEO_OPEN:-/usr/bin/open}"
note() { printf '{"reason": "%s", "at": %s}\n' "$1" "$(date +%s)" > "$failure"; }
waited=0
while kill -0 "$pid" 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -gt 600 ]; then note "old app did not exit"; rm -rf "$staged"; exit 1; fi
    sleep 0.2
done
restore() {
    rm -rf "$app"
    if [ -d "$backup" ]; then /bin/mv "$backup" "$app"; fi
    rm -rf "$staged"
    "$opener" "$app"
}
[ "$inject" = "before_backup" ] && { note "injected failure"; rm -rf "$staged"; "$opener" "$app"; exit 1; }
if ! /bin/mv "$app" "$backup"; then note "could not set the old app aside"; rm -rf "$staged"; "$opener" "$app"; exit 1; fi
if [ "$inject" = "after_backup" ] || ! /bin/mv "$staged" "$app"; then note "could not put the new app in place"; restore; exit 1; fi
if [ "$inject" = "after_swap" ] || ! "$opener" "$app"; then
    note "the new app did not open"; /bin/mv "$app" "$staged" && restore; exit 1
fi
# The old app stays until the new launcher has run well; it removes it (settle).
'''


class MacUpdateUnavailable(ValueError):
    """The app cannot be replaced from here; the release page stays the way to update."""


def current_app(executable=None):
    """The .app bundle the process runs from, or None outside one."""
    try:
        path = Path(executable or sys.executable).resolve()
    except OSError:
        return None
    for parent in path.parents:
        if parent.suffix == '.app' and (parent / 'Contents/MacOS').is_dir():
            return parent
    return None


def replaceable(app=None):
    """Whether this app sits where the launcher may swap it for a new one."""
    app = app or current_app()
    if app is None or 'AppTranslocation' in str(app) or sys.platform != 'darwin' and not os.environ.get('FREEVIDEO_MAC_UPDATE_TEST'):
        return False
    return os.access(app.parent, os.W_OK | os.X_OK) and os.access(app, os.W_OK)


def _run(command, run, timeout=1800):
    return run(command, check=True, capture_output=True, timeout=timeout)


def _plist(app):
    with (app / 'Contents/Info.plist').open('rb') as stream:
        return plistlib.load(stream)


def _size(path):
    return sum(f.stat().st_size for f in Path(path).rglob('*') if f.is_file() and not f.is_symlink())


def clear_stale(app):
    for entry in app.parent.glob(MARK + '*.app'):
        shutil.rmtree(entry, ignore_errors=True)


def settle(app):
    """Remove the old versions kept beside a running app; called once it has run well."""
    for entry in app.parent.glob(BACKUP + '*.app'):
        shutil.rmtree(entry, ignore_errors=True)


def prepare(dmg, app, directory, *, run=subprocess.run):
    """Copy and check the app inside dmg next to `app`; returns the staged path.

    Nothing here touches the running app. Every failure raises and leaves the
    old version as it was."""
    if not replaceable(app):
        raise MacUpdateUnavailable('This app cannot replace itself where it is installed')
    clear_stale(app)
    staged = app.parent / (MARK + '%d-%d.app' % (os.getpid(), int(time.time())))
    mount = Path(tempfile.mkdtemp(prefix='freevideo-update-mount-'))
    attached = False
    try:
        _run([HDIUTIL, 'attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', str(mount), str(dmg)], run)
        attached = True
        apps = sorted(p for p in mount.iterdir() if p.suffix == '.app')
        if len(apps) != 1 or apps[0].name != app.name:
            raise ValueError('The downloaded image does not contain %s' % app.name)
        source = apps[0]
        free = shutil.disk_usage(app.parent).free
        if free < _size(source) + MARGIN_BYTES:
            raise OSError(28, 'Not enough free space next to the app')
        _run([DITTO, str(source), str(staged)], run)
    finally:
        if attached:
            try:
                _run([HDIUTIL, 'detach', str(mount)], run, 120)
            except (subprocess.SubprocessError, OSError):
                try:
                    _run([HDIUTIL, 'detach', '-force', str(mount)], run, 120)
                except (subprocess.SubprocessError, OSError):
                    pass
        shutil.rmtree(mount, ignore_errors=True)
    try:
        old, new = _plist(app), _plist(staged)
        if new.get('CFBundleIdentifier') != old.get('CFBundleIdentifier'):
            raise ValueError('The downloaded app is a different application')
        if not (staged / 'Contents/MacOS' / new.get('CFBundleExecutable', '')).is_file():
            raise ValueError('The downloaded app has no executable')
        if sys.platform == 'darwin':
            _run([XATTR, '-dr', 'com.apple.quarantine', str(staged)], run, 120)
        _run([CODESIGN, '--verify', '--deep', '--strict', str(staged)], run, 300)
    except BaseException:
        shutil.rmtree(staged, ignore_errors=True)
        raise
    return staged


def activate(staged, app, directory, *, popen=subprocess.Popen, inject=''):
    """Start the swap. It waits for this process to exit, then replaces the app."""
    staged = Path(staged)
    if not (staged / 'Contents/Info.plist').is_file():
        raise FileNotFoundError('The prepared app is missing')
    directory = Path(directory)
    script = directory / 'swap-app.sh'
    script.write_text(SWAP_SCRIPT, encoding='utf-8')
    script.chmod(0o755)
    backup = app.parent / (BACKUP + '%d.app' % int(time.time()))
    failure = directory.parent / 'mac-update-failed.json'
    failure.unlink(missing_ok=True)
    with (directory.parent / 'mac-update.log').open('ab') as log:
        return popen(['/bin/sh', str(script), str(os.getpid()), str(app), str(staged), str(backup), str(failure), inject],
                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True, start_new_session=True)
