"""Memory readings and a fixed-word reading of how a generation worker ended.

A worker that the system ends cannot report its own memory, so the process that
started it takes the readings: once when the request starts and once when the
exit is seen. Only numbers and fixed words leave this module, never text from
the worker, so a diagnostic report stays free of user data.
"""
import os
import re
import tempfile

from .system import windows

# Exit codes of a Windows process that the system, not the program, ended.
_SYSTEM_STATUS = {
    0xC000012D: 'commit_limit',      # STATUS_COMMITMENT_LIMIT
    0xC0000017: 'no_memory',         # STATUS_NO_MEMORY
    0xC00000FD: 'stack_overflow',    # STATUS_STACK_OVERFLOW
}
_CRASH_PREFIXES = (0xC0000000, 0x80000000)
_FIELDS = ('physical_available_bytes', 'commit_available_bytes', 'commit_limit_bytes', 'total_bytes')


def _count(value):
    return value if type(value) is int and value >= 0 else None


def memory_sample(pid=None):
    """Free physical memory, commit headroom and the working set of one process.

    The process is this one unless a pid is given. A value the system does not
    report is None; the function never raises.
    """
    import os
    sample = dict.fromkeys(_FIELDS)
    sample.update(process_working_set_bytes=None, process_private_commit_bytes=None)
    try:
        from .system import system_memory
        sample.update({key: _count(value) for key, value in system_memory().items() if key in _FIELDS})
    except Exception:
        pass
    pid = os.getpid() if pid is None else pid
    try:
        if windows():
            from .win32 import process_memory
            row = process_memory(pid)
            if row and 'rss_bytes' in row:
                sample['process_working_set_bytes'] = _count(row['rss_bytes'])
                sample['process_private_commit_bytes'] = _count(row['private_commit_bytes'])
        else:
            # Linux has no private commit figure: statm's first column is the whole address
            # space, tens of GB for a CUDA process, so only the resident size is recorded.
            with open('/proc/%d/statm' % pid, encoding='ascii') as stream:
                resident = stream.read().split()[1]
            sample['process_working_set_bytes'] = int(resident) * os.sysconf('SC_PAGE_SIZE')
    except Exception:
        pass
    return {key: sample[key] for key in sample if sample[key] is not None}


def exit_reading(code, *, requested_stop=False, system=None):
    """The exit code as given, a fixed-word class and whether the system probably ended it.

    requested_stop is true when this program asked the worker to stop: its own
    stop is never counted as the system ending it.
    """
    on_windows = windows() if system is None else system == 'Windows'
    result = dict(exit_code=code if type(code) is int else None)
    if type(code) is not int:
        result.update(exit_class='unknown', suspected_system_kill=False)
        return result
    unsigned = code & 0xFFFFFFFF
    if on_windows or code > 255:
        result['exit_code_unsigned'] = unsigned
    if code == 0:
        kind, suspected = 'clean', False
    elif requested_stop:
        kind, suspected = 'stopped_by_us', False
    elif on_windows or code > 255:
        if unsigned == 0xFFFFFFFF:
            # TerminateProcess(-1): our own stop ends workers with 1, so this came from outside.
            kind, suspected = 'terminated_externally', True
        elif unsigned in _SYSTEM_STATUS:
            kind, suspected = 'system_' + _SYSTEM_STATUS[unsigned], True
        elif unsigned == 0xC000013A:
            kind, suspected = 'interrupted', False
        elif unsigned & 0xF0000000 in _CRASH_PREFIXES:
            kind, suspected = 'native_crash', False
        else:
            kind, suspected = 'error_exit', False
    elif code < 0 or code > 128:
        # Python reports a signal as -N; a shell-style status is 128 + N.
        signal = -code if code < 0 else code - 128
        if signal in (9, 15):
            kind, suspected = 'killed_by_signal', True
        elif signal in (4, 6, 7, 8, 11):
            kind, suspected = 'native_crash', False
        else:
            kind, suspected = 'signal', False
    else:
        kind, suspected = 'error_exit', False
    result.update(exit_class=kind, suspected_system_kill=suspected)
    return result


CRASH_FILE_ENV = 'FREEVIDEO_CRASH_FILE'
_FRAME = re.compile(r'^\s+File "(?P<file>[^"]*)", line (?P<line>\d+) in (?P<name>[A-Za-z0-9_<>.]{1,80})\s*$')
_FRAME_OUT = re.compile(r'^[A-Za-z0-9_.-]{1,80}:\d{1,7} [A-Za-z0-9_<>.]{1,80}$')
MAX_FRAMES = 40


def new_crash_file():
    """An empty file the worker's crash handler writes the native crash's Python stack to."""
    handle, path = tempfile.mkstemp(prefix='freevideo-crash-', suffix='.txt')
    os.close(handle)
    return path


def read_crash_stack(path):
    """Frames of the crashed thread as 'file.py:line function': no folder, no other text."""
    try:
        with open(path, encoding='utf-8', errors='replace') as stream:
            text = stream.read(64 * 1024)
    except (OSError, TypeError):
        return []
    frames = []
    for line in text.splitlines():
        match = _FRAME.match(line)
        if match:
            name = re.split(r'[\\/]', match.group('file'))[-1]
            frames.append('%s:%s %s' % (name[-80:], match.group('line'), match.group('name')))
        if len(frames) >= MAX_FRAMES:
            break
    return [frame for frame in frames if _FRAME_OUT.match(frame)]


_SAMPLE_KEYS = _FIELDS + ('process_working_set_bytes', 'process_private_commit_bytes')
_CLASSES = frozenset({'clean', 'stopped_by_us', 'terminated_externally', 'interrupted', 'native_crash',
                      'error_exit', 'killed_by_signal', 'signal', 'unknown'}
                     | {'system_' + name for name in _SYSTEM_STATUS.values()})


def clean_sample(value):
    value = value if isinstance(value, dict) else {}
    return {key: value[key] for key in _SAMPLE_KEYS if _count(value.get(key)) is not None}


def clean_reading(value):
    """Only the numbers and fixed words of an exit reading, for any report."""
    value = value if isinstance(value, dict) else {}
    result = {}
    for key in ('exit_code', 'exit_code_unsigned', 'earlier_exit_code'):
        if type(value.get(key)) is int and -2**63 <= value[key] < 2**64:
            result[key] = value[key]
    if value.get('exit_class') in _CLASSES:
        result['exit_class'] = value['exit_class']
    if type(value.get('suspected_system_kill')) is bool:
        result['suspected_system_kill'] = value['suspected_system_kill']
    memory = clean_sample(value.get('memory'))
    if memory:
        result['memory'] = memory
    stack = value.get('native_stack')
    if isinstance(stack, list):
        frames = [row for row in stack[:MAX_FRAMES] if isinstance(row, str) and _FRAME_OUT.match(row)]
        if frames:
            result['native_stack'] = frames
    return result
