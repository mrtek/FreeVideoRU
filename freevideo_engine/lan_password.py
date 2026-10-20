"""Optional LAN password and private, atomic authentication records.

The engine root is the same root used by launcher_settings.Store. Passwords
never enter launcher preferences; only the fixed scrypt record is persisted.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets

from .agent import private_file
from .long_paths import io_path

MIN_LENGTH = 6
N, R, P = 2 ** 15, 8, 1
PASSWORD_FILE = 'lan-password.json'
DEVICES_FILE = 'lan-devices.json'


def path(engine):
    # Extended form on Windows, so long installation roots work for every reader.
    return io_path(Path(engine) / 'launcher' / PASSWORD_FILE)


def is_set(engine):
    # An unreadable or invalid record must never silently disable protection.
    return path(engine).exists()


def save_private(target, value):
    target = io_path(target)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = target.with_name('.' + target.name + '-' + secrets.token_hex(8))
    descriptor = private_file.create(temporary)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def clear_devices(engine):
    save_private(path(engine).with_name(DEVICES_FILE), dict(version=1, devices=[]))


def derive(text, salt):
    # OpenSSL's default 32 MiB cap is slightly below this parameter set's needs.
    return hashlib.scrypt(text.encode('utf-8'), salt=salt, n=N, r=R, p=P, dklen=32, maxmem=64 * 1024 ** 2)


def read(engine):
    try:
        with path(engine).open(encoding='utf-8') as stream:
            value = json.loads(stream.read(4096))
        if (value['version'], value['n'], value['r'], value['p']) != (1, N, R, P):
            return None
        salt, digest = bytes.fromhex(value['salt']), bytes.fromhex(value['hash'])
        return (salt, digest) if len(salt) == 16 and len(digest) == 32 else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def verify_record(record, text):
    salt, expected = record if record is not None else (bytes(16), bytes(32))
    actual = derive(text, salt)
    return hmac.compare_digest(actual, expected) and record is not None


def verify(engine, text):
    return verify_record(read(engine), text)


def set_password(engine, text):
    if not isinstance(text, str) or len(text) < MIN_LENGTH:
        raise ValueError('LAN password is too short')
    salt = secrets.token_bytes(16)
    digest = derive(text, salt)
    # Device records also carry this password generation, so concurrent logins
    # using the old record cannot revive devices during an atomic replacement.
    clear_devices(engine)
    save_private(path(engine), dict(version=1, salt=salt.hex(), n=N, r=R, p=P, hash=digest.hex()))


def remove(engine):
    clear_devices(engine)
    path(engine).unlink(missing_ok=True)
