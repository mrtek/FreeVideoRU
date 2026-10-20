"""Proxy-owned device sessions and in-memory password attempt limits."""
from collections import deque
from datetime import datetime, timezone
import hashlib
import json
import math
import secrets

from . import lan_password

DEVICE_COOKIE = 'freevideo_device'
REMEMBER_SECONDS = 30 * 86400
SESSION_SECONDS = 12 * 3600
LOGIN_DELAY = .25
TOUCH_SECONDS = 60
MAX_SOURCES = 1024


class Attempts:
    def __init__(self):
        self.sources = {}
        self.failures = deque()
        self.global_until = 0

    def remaining(self, ip, now):
        return max(0, math.ceil(max(self.global_until, self.sources.get(ip, (0, 0))[1]) - now))

    def failed(self, ip, now):
        count = self.sources.get(ip, (0, 0))[0] + 1
        until = now + min(900, 60 * 2 ** min(count - 5, 4)) if count >= 5 else 0
        self.sources[ip] = count, until
        if len(self.sources) > MAX_SOURCES:
            for key in [key for key, (_, wait) in self.sources.items() if wait <= now and key != ip]:
                del self.sources[key]
            while len(self.sources) > MAX_SOURCES:
                del self.sources[next(iter(self.sources))]
        while self.failures and self.failures[0] <= now - 600:
            self.failures.popleft()
        self.failures.append(now)
        # Deliberate: a burst of failures from many sources locks every login for five minutes,
        # so guessing across addresses cannot outrun the per-source delay. The owner waits it out.
        if len(self.failures) >= 30:
            self.global_until = now + 300
        return self.remaining(ip, now)

    def success(self, ip):
        self.sources.pop(ip, None)


class PasswordAuth:
    def __init__(self, engine):
        self.engine = engine
        self.signature = None
        self.enabled = False
        self.record = None
        self.attempts = Attempts()

    def reload(self):
        if self.engine is None:
            return
        try:
            info = lan_password.path(self.engine).stat()
            signature = info.st_mtime_ns, info.st_ino, info.st_size
        except FileNotFoundError:
            signature = None
        except OSError:
            signature = 'unreadable'
        self.enabled = signature is not None
        if signature != self.signature:
            self.record = lan_password.read(self.engine) if self.enabled else None
            self.signature = signature

    def generation(self):
        return hashlib.sha256(b''.join(self.record)).hexdigest() if self.record else ''

    def devices(self, now):
        try:
            target = lan_password.path(self.engine).with_name(lan_password.DEVICES_FILE)
            value = json.loads(target.read_text(encoding='utf-8'))
            if not isinstance(value, dict) or value.get('password') != self.generation() or not self.record:
                return []
            return [row for row in value['devices'] if isinstance(row, dict) and isinstance(row['hash'], str) and
                    len(row['hash']) == 64 and all(c in '0123456789abcdef' for c in row['hash']) and
                    all(type(row[key]) in (int, float) and math.isfinite(row[key]) for key in ('created', 'last_used')) and
                    type(row['remember']) is bool and
                    now < (row['last_used'] + REMEMBER_SECONDS if row['remember'] else row['created'] + SESSION_SECONDS)]
        except (OSError, ValueError, KeyError, TypeError):
            return []

    def save(self, rows):
        lan_password.save_private(lan_password.path(self.engine).with_name(lan_password.DEVICES_FILE),
                                  dict(version=1, password=self.generation(), devices=rows))

    def issue(self, remember, now):
        value = secrets.token_urlsafe(32)
        digest = hashlib.sha256(value.encode()).hexdigest()
        rows = self.devices(now)
        rows.append(dict(hash=digest, created=now, last_used=now, remember=remember))
        self.save(rows)
        return value

    def authenticate(self, value, now):
        if not value or len(value) != 43 or not self.record:
            return None
        digest = hashlib.sha256(value.encode()).hexdigest()
        rows = self.devices(now)
        for row in rows:
            if secrets.compare_digest(row['hash'], digest):
                if now - row['last_used'] >= TOUCH_SECONDS:
                    row['last_used'] = now
                    self.save(rows)
                return row
        return None

    def log(self, ip, result):
        target = lan_password.path(self.engine).with_name('access-proxy.log')
        with target.open('a', encoding='utf-8') as stream:
            stream.write('%s %s %s\n' % (datetime.now(timezone.utc).isoformat(), ip, result))
