"""Keep both frozen-resource and engine-source paths with one stored payload."""
import json
import os
from pathlib import Path

from scripts.prune_qt_bundle import checked_path

LINK_MANIFEST = '_freevideo-data-links.json'


def deduplicate_bundle_data(dist, *, symbolic=False):
    """Only replace byte-identical regular files; symlinks stay inside dist."""
    dist = Path(dist).resolve(strict=True)
    rows = []
    for source_root in sorted(dist.rglob('engine-source')):
        if not source_root.is_dir() or source_root.is_symlink():
            continue
        internal = source_root.parent
        for source in sorted(source_root.rglob('*')):
            if source.is_symlink() or not source.is_file():
                continue
            target = internal / source.relative_to(source_root)
            if target.is_symlink() or not target.is_file():
                continue
            checked_path(source, dist)
            checked_path(target, dist)
            if source.samefile(target) or source.read_bytes() != target.read_bytes():
                continue
            size = target.stat().st_size
            temporary = target.with_name(target.name + '.dedup-link')
            if symbolic:
                temporary.symlink_to(os.path.relpath(source, target.parent))
            else:
                os.link(source, temporary)
            temporary.replace(target)
            rows.append(dict(path=target.relative_to(dist).as_posix(),
                             source=source.relative_to(dist).as_posix(), bytes=size))
    return dict(files=rows, bytes=sum(row['bytes'] for row in rows))


def deduplicate_toc(entries, out):
    """Onefile stores one copy; its packaging hook restores hardlink aliases.

    Do this only for a onefile extraction, which is owned and writable. An
    installed onedir tree must be complete before a normal user launches it.
    """
    sources = {name.replace('\\', '/'): source for name, source, kind in entries if kind == 'DATA'}
    kept, rows = [], []
    for entry in entries:
        name, source, kind = entry
        name = name.replace('\\', '/')
        canonical = 'engine-source/' + name
        if (kind == 'DATA' and not name.startswith('engine-source/') and canonical in sources
                and Path(source).read_bytes() == Path(sources[canonical]).read_bytes()):
            rows.append(dict(path=name, source=canonical, bytes=Path(source).stat().st_size))
        else:
            kept.append(entry)
    manifest = Path(out) / LINK_MANIFEST
    manifest.write_text(json.dumps(rows, indent=2) + '\n', encoding='utf-8')
    kept.append((LINK_MANIFEST, str(manifest), 'DATA'))
    return kept, dict(files=rows, bytes=sum(row['bytes'] for row in rows))


def write_data_report(out, result):
    (Path(out) / 'data-deduplicated.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print('Data dedup: %d files, %d bytes' % (len(result['files']), result['bytes']), flush=True)
