"""Restore data aliases in an owned PyInstaller onefile extraction on Windows."""


def restore_data_links(bundle):
    import json
    import os
    from pathlib import Path
    import shutil

    bundle = Path(bundle).resolve()
    rows = json.loads((bundle / '_freevideo-data-links.json').read_text(encoding='utf-8'))
    for row in rows:
        source, target = bundle / row['source'], bundle / row['path']
        if not source.resolve().is_relative_to(bundle) or not target.resolve().is_relative_to(bundle):
            raise ValueError('Data alias escapes the extracted bundle')
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(source, target)
        except OSError:
            # FAT/exFAT or a policy forbidding hardlinks must still launch. The
            # archive contains only one copy even if extraction needs a copy.
            shutil.copyfile(source, target)


if __name__ == '__main__':
    import sys
    restore_data_links(sys._MEIPASS)
