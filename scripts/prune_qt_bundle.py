"""Build-only Qt exclusions for the software-rendered, Basic-style launcher."""
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path, PurePosixPath
import shutil


UNUSED_STYLES = ('FluentWinUI3', 'Fusion', 'Imagine', 'Material', 'Universal',
                 'Windows', 'macOS', 'iOS')
UNUSED_MODULES = ('QtQuick/Dialogs', 'QtWayland/Compositor', 'QtTest', 'Qt/labs',
                  'QtQuick/Particles', 'QtQuick/VectorImage', 'QtQuick/Effects',
                  'QtQuick/Timeline', 'QtQuick/Timeline/BlendTrees', 'QtQuick/Pdf', 'QtPdf',
                  'QtQuick/LocalStorage', 'QtQml/XmlListModel', 'QtQuick/VirtualKeyboard')
UNUSED_LIBRARIES = (
    'Labs*', 'QuickControls2FluentWinUI3StyleImpl', 'QuickControls2Fusion*',
    'QuickControls2Imagine*', 'QuickControls2Material*', 'QuickControls2Universal*',
    'QuickControls2WindowsStyleImpl', 'QuickControls2MacOSStyleImpl', 'QuickControls2IOSStyleImpl',
    'QuickDialogs2*', 'WaylandCompositor*', 'Test', 'QuickTest', 'QuickParticles',
    'QuickVectorImage*', 'QuickEffects', 'QuickTimeline*', 'Pdf*', 'Sql',
    'QmlLocalStorage', 'QmlXmlListModel', 'VirtualKeyboard*',
)
# Relative to PySide6, across Windows wheels, Unix wheels and macOS frameworks.
# Keep Controls/Basic, Controls/impl, Templates, QtQuick, Layouts, Widgets and
# Wayland *client* plugins. No broad "Qt*" or platform-plugin exclusions.
QT_PRUNE_GLOBS = (
    'opengl32sw.dll', 'Qt/opengl32sw.dll', 'translations', 'Qt/translations',
    *(f'{prefix}qml/QtQuick/Controls/{style}' for prefix in ('', 'Qt/') for style in UNUSED_STYLES),
    *(f'{prefix}qml/{module}' for prefix in ('', 'Qt/') for module in UNUSED_MODULES),
    *(f'{prefix}plugins/{plugin}' for prefix in ('', 'Qt/')
      for plugin in ('qmltooling', 'platforms/qdirect2d.dll', 'sqldrivers', 'virtualkeyboard')),
    *(f'Qt6{library}.dll' for library in UNUSED_LIBRARIES),
    *(f'Qt/lib/libQt6{library}.so*' for library in UNUSED_LIBRARIES),
    *(f'Qt/lib/Qt{library}.framework' for library in UNUSED_LIBRARIES),
    *(f'Qt/lib/libQt6{library}*.dylib' for library in UNUSED_LIBRARIES),
    'QtTest*.pyd', 'QtTest*.so', 'QtSql*.pyd', 'QtSql*.so',
    'QtPdf*.pyd', 'QtPdf*.so',
)


def should_prune(name):
    """The same matcher serves emitted bundles and PyInstaller onefile TOCs."""
    parts = PurePosixPath(str(name).replace('\\', '/')).parts
    if 'PySide6' not in parts:
        return False
    relative = '/'.join(parts[parts.index('PySide6') + 1:])
    return any(fnmatchcase(relative, pattern) or fnmatchcase(relative, pattern + '/*')
               for pattern in QT_PRUNE_GLOBS)


def checked_path(path, dist):
    if not path.resolve().is_relative_to(dist) or path == dist:
        raise ValueError('Bundle path escapes dist: ' + str(path))


def prune_qt_bundle(dist):
    """Remove only explicit Qt globs; return every removed entry and real bytes."""
    dist = Path(dist).resolve(strict=True)
    selected, rows = [], []
    for folder, dirs, files in os.walk(dist, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(folder) / name
            if should_prune(path.relative_to(dist)):
                checked_path(path, dist)
                selected.append(path)
                if name in dirs:
                    dirs.remove(name)
    # Validate all descendants before making any change. Never follow directory links.
    for path in selected:
        entries = [path]
        if path.is_dir() and not path.is_symlink():
            entries += list(path.rglob('*'))
        for entry in entries:
            checked_path(entry, dist)
            if entry.is_file() or entry.is_symlink():
                rows.append(dict(path=entry.relative_to(dist).as_posix(),
                                 bytes=0 if entry.is_symlink() else entry.stat().st_size))
    for path in selected:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
    return dict(files=sorted(rows, key=lambda row: row['path']),
                bytes=sum(row['bytes'] for row in rows))


def prune_qt_toc(entries):
    """Onefile has no emitted tree: filter after Analysis, before its CArchive."""
    kept, rows = [], []
    for entry in entries:
        name, source, kind = entry
        if should_prune(name):
            size = Path(source).stat().st_size if kind != 'SYMLINK' else 0
            rows.append(dict(path=name, bytes=size))
        else:
            kept.append(entry)
    return kept, dict(files=rows, bytes=sum(row['bytes'] for row in rows))


def write_prune_report(out, result):
    (Path(out) / 'qt-pruned.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print('Qt prune: %d files, %d bytes' % (len(result['files']), result['bytes']), flush=True)
