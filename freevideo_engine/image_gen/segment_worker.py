"""CPU-only point selection worker. Idle exit releases the entire Torch allocator."""
import argparse
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import queue
import sys

from .worker import Inbox


def serve(checkpoint, *, idle_seconds=45., stream=None, output=None, factory=None):
    from .segment import Segmenter, load_image, validate_points
    stream = sys.stdin if stream is None else stream
    output = sys.stdout if output is None else output
    factory = factory or Segmenter

    def send(**row):
        output.write(json.dumps(row, allow_nan=False) + '\n')
        output.flush()

    inbox = Inbox(stream, send)
    segmenter = None
    try:
        while not inbox.closed.is_set():
            try:
                value = inbox.rows.get(timeout=idle_seconds)
            except queue.Empty:
                break
            if value is None or inbox.closed.is_set():
                break
            send(phase='accepted')
            stage = 'start'
            try:
                with redirect_stdout(sys.stderr):
                    image = load_image(value['image'])
                    validate_points(value['points'], image.size)
                    stage = 'load'
                    if segmenter is None:
                        segmenter = factory(checkpoint)
                    stage = 'encode'
                    mask = segmenter.segment(image, value['points'])
                    if inbox.cancel.is_set():
                        break
                    with Path(value['path']).open('xb') as target:
                        mask.save(target, format='PNG')
                result = dict(phase='result', path=value['path'])
            except Exception as error:
                from .failure import classify_exception
                code = str(error) if str(error) in ('invalid_media', 'invalid_points') else classify_exception(error, stage=stage)
                result = dict(phase='error', code=code)
            with inbox.mutex:
                inbox.busy = False
                send(**result)
    finally:
        inbox.closed.set()
        if segmenter is not None:
            segmenter.clear_image()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('--idle-seconds', type=float, default=45.)
    args = parser.parse_args()
    if not 0 < args.idle_seconds < float('inf'):
        parser.error('idle-seconds must be positive and finite')
    # Set before importing Torch or torchvision; this process never uses CUDA/MPS.
    os.environ.update(CUDA_VISIBLE_DEVICES='', HIP_VISIBLE_DEVICES='',
                      OMP_NUM_THREADS='4', MKL_NUM_THREADS='4', OPENBLAS_NUM_THREADS='4')
    stream = None
    if os.name == 'nt':
        from ..win32 import private_stdin
        stream = private_stdin()
    serve(args.checkpoint, idle_seconds=args.idle_seconds, stream=stream)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
