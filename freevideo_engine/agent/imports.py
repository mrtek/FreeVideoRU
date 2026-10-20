"""Content uploads into the editor's import store and software transcode queue."""
import asyncio
import base64
import binascii
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
from urllib.parse import quote, urlencode

from .. import comfy_editor as editor
from . import media, schema, spec
from .jobs import JobError


def invalid(path, expected, code='invalid_media'):
    error = spec.SpecError(schema.diagnostic(path, expected, None))
    error.code = code
    raise error


def view(value):
    fields = ('id', 'name', 'kind', 'state', 'fraction', 'reason', 'frames', 'fps', 'width', 'height',
              'preview_width', 'preview_height', 'has_audio')
    row = {key: value.get(key) for key in fields}
    row['fps'] = value.get('fps', editor.FPS)
    row['has_audio'] = value.get('has_audio', False)
    row['source'] = 'import:' + value['id']
    for kind in ('preview', 'thumbnail'):
        row[kind] = (schema.PREFIX + '/editor/sources/content?' + urlencode(dict(key=row['source'], file=kind))
                     if row['state'] == 'ready' else None)
    return row


def listing(root):
    return dict(items=[view(row) for row in editor.list_imports(root)])


def replay(root, receipt):
    if receipt is None:
        return None
    for row in editor.list_imports(root):
        value = editor._read_import(root, row['id'])
        saved = value.get('agent_receipt')
        if saved and (saved.get('client'), saved.get('ref')) == (receipt['client'], receipt['ref']):
            if saved['digest'] != receipt['digest']:
                invalid('/ref', 'the same filename and content for a replay', 'idempotency_conflict')
            return view(row)
    return None


class Content:
    """Adapt a checked upload to the page's streaming receiver, without a server-side path API."""
    def __init__(self, path):
        self.path = path

    async def iter_chunked(self, size):
        with self.path.open('rb') as stream:
            while chunk := await asyncio.to_thread(stream.read, size):
                yield chunk


async def upload(request, value, root, manager, lock, decoders):
    if manager is None:
        raise JobError('not_ready', 'Editor import queue unavailable')
    # Temporary content stays beside the destination, and is removed on rejection or disconnect.
    with tempfile.TemporaryDirectory(prefix='.agent-import-', dir=root) as temporary:
        multipart = request.content_type == 'multipart/form-data'
        field = '/file' if multipart else '/data_base64'
        ref = None if multipart else value.get('ref')
        if multipart:
            reader = await request.multipart()
            part = await reader.next()
            if part is None or getattr(part, 'name', None) != 'file' or not getattr(part, 'filename', None):
                invalid('/file', 'one nonempty file part, followed by optional ref')
            name = part.filename
        else:
            name = value['name']
        spec.import_name(name)
        target = Path(temporary) / ('media' + Path(name).suffix.lower())
        digest = hashlib.sha256()
        size = 0
        with target.open('xb') as stream:
            if multipart:
                while chunk := await part.read_chunk(size=256 * 1024):
                    size += len(chunk)
                    if size > schema.MAX_UPLOAD_BYTES:
                        raise JobError('too_large', 'Upload exceeds limit', limit_bytes=schema.MAX_UPLOAD_BYTES)
                    digest.update(chunk)
                    await asyncio.to_thread(stream.write, chunk)
                extra = await reader.next()
                if extra is not None:
                    if getattr(extra, 'name', None) != 'ref' or getattr(extra, 'filename', None):
                        invalid('/file', 'one file part followed only by optional ref')
                    data = bytearray()
                    while chunk := await extra.read_chunk():
                        data.extend(chunk)
                        if len(data) > 1024:
                            spec.fail('/ref', 'a ref of at most 128 characters')
                    try:
                        ref = data.decode('utf-8')
                    except UnicodeDecodeError:
                        spec.fail('/ref', 'a UTF-8 ref')
                    if await reader.next() is not None:
                        invalid('/file', 'one file part followed only by optional ref')
            else:
                try:
                    data = base64.b64decode(value['data_base64'], validate=True)
                except (binascii.Error, ValueError):
                    invalid(field, 'valid base64-encoded video or audio content')
                size = len(data)
                if size > schema.MAX_UPLOAD_BYTES:
                    raise JobError('too_large', 'Upload exceeds limit', limit_bytes=schema.MAX_UPLOAD_BYTES)
                digest.update(data)
                await asyncio.to_thread(stream.write, data)
        if not size:
            invalid(field, 'nonempty video or audio content')
        key = request.headers.get('Idempotency-Key')
        for where, candidate in (('/ref', ref), ('/headers/Idempotency-Key', key)):
            if candidate is not None:
                problems = schema.issues(schema.REF, candidate, where)
                if problems:
                    raise spec.SpecError(problems)
        if ref and key and ref != key:
            invalid('/ref', 'the same value as Idempotency-Key', 'idempotency_conflict')
        ref = key or ref
        receipt = (dict(ref=ref, client=request.headers.get('X-FreeVideo-Client', '')[:80] or None,
                        digest=hashlib.sha256(name.encode() + b'\0' + digest.digest()).hexdigest()) if ref else None)
        async with decoders:
            try:
                await asyncio.to_thread(media.validate_upload, target)
            except (OSError, ValueError, SyntaxError):
                invalid(field, 'decodable video or audio within the media upload limits')
        async with lock:
            previous = await asyncio.to_thread(replay, root, receipt)
            if previous is not None:
                return {'import': previous}, 200
            adapted = SimpleNamespace(content_length=size, headers={'X-FreeVideo-Filename': quote(name, safe='')},
                                      content=Content(target))
            made = await editor.receive(adapted, root, receipt=receipt)
            manager.submit(made['id'])
            return {'import': view(made)}, 201
