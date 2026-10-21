#!/usr/bin/env python3
"""Preserve readable validation evidence in job logs when artifact storage is full."""
from pathlib import Path
import sys


def main(paths):
    for name in paths:
        root = Path(name)
        if not root.exists():
            print('Evidence directory unavailable: ' + str(root))
            continue
        for path in sorted(root.rglob('*')):
            if not path.is_file() or path.suffix not in ('.txt', '.json', '.tsv', '.sha256', '.log', '.diff'):
                continue
            data = path.read_text(errors='replace')
            # Compiler failures are also printed immediately by the drivers.
            # Keep the final diagnostic context in CI logs without flooding them.
            if path.suffix == '.log' and len(data) > 16384:
                data = '[earlier log content omitted here; full log remains in the worker evidence directory]\n' + data[-16384:]
            print('\nEvidence: ' + str(path), flush=True)
            print(data, end='' if data.endswith('\n') else '\n', flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])
