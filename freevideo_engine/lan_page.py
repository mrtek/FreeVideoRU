"""Local page LAN settings, independent of the HTTP server."""
import socket
import time

from . import lan_auth, lan_password
from .launcher_settings import Store, default_language


class LanUnavailable(RuntimeError):
    """The launcher has not recorded an installation on this computer."""


class InvalidRequest(ValueError):
    def __init__(self, field, allowed, got):
        self.field, self.allowed, self.got = field, allowed, got
        super().__init__('%s must be %s' % (field or 'body', allowed))


def read(engine):
    installation = Store(engine).read().get('installation')
    flag = bool(installation and installation.get('lan_access') is True)
    port = installation.get('lan_port') if installation else None
    enabled = False
    if flag and port is not None:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.3):
                enabled = True
        except OSError:
            pass
    password_set = lan_password.is_set(engine)
    auth = lan_auth.PasswordAuth(engine)
    auth.reload()
    link = ''
    if enabled:
        from .comfy_launcher_runtime import lan_access_links
        links = lan_access_links(engine, port, password_set=password_set)
        link = links[0] if links else ''
    return dict(available=installation is not None, enabled=enabled, starting=flag and not enabled,
                link=link, password_set=password_set, devices=len(auth.devices(time.time())),
                min_length=lan_password.MIN_LENGTH)


def apply(engine, body):
    if not isinstance(body, dict) or not body:
        raise InvalidRequest('', 'a nonempty object containing enabled or password', body)
    for field in body:
        if field not in ('enabled', 'password'):
            raise InvalidRequest(field, 'absent (unknown field)', None)
    if 'enabled' in body and type(body['enabled']) is not bool:
        raise InvalidRequest('enabled', 'a boolean', body['enabled'])
    if 'password' in body:
        password = body['password']
        if password is not None and not isinstance(password, str):
            raise InvalidRequest('password', 'a string or null', password)
        if isinstance(password, str) and len(password) < lan_password.MIN_LENGTH:
            raise InvalidRequest('password', 'at least %d characters (min_length=%d)' % (
                lan_password.MIN_LENGTH, lan_password.MIN_LENGTH), password)
    store = Store(engine)
    with store.exclusive():
        saved = store.read()
        installation = saved.get('installation')
        if installation is None:
            raise LanUnavailable()
        # Validate the whole request and installation before changing authentication.
        if 'password' in body:
            if body['password'] is None:
                lan_password.remove(engine)
            else:
                lan_password.set_password(engine, body['password'])
        if 'enabled' in body:
            installation = dict(installation, lan_access=body['enabled'])
            # access.lan_enabled() checks the current top-level permission copies.
            saved['lan_access'] = body['enabled']
            store.write_locked(saved, saved.get('language', default_language()), installation, saved.get('setup'))
    return read(engine)
