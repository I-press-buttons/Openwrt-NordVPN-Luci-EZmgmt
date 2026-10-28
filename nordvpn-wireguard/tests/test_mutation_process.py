#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Real processes, flock descriptors and stale cached UCI snapshots; no router."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
LIB = HERE.parent / 'files/usr/share/ucode'
UCODE = os.environ.get('UCODE', 'ucode')
BASE = [UCODE, '-L', str(HERE / 'process/*.uc'), '-L', str(LIB / '*.uc')]
if os.environ.get('UCODE_EXTRA_L'):
    BASE += ['-L', os.environ['UCODE_EXTRA_L']]


def check(label, condition):
    if not condition:
        raise AssertionError(label)
    print('ok ' + label, flush=True)


with tempfile.TemporaryDirectory(prefix='nordvpn_mutation_') as tmp:
    root = Path(tmp)
    store = root / 'uci.json'
    names = [f'mtest_{os.getpid()}_a', f'mtest_{os.getpid()}_b']
    command = BASE + ['-D', 'PROCESS_STORE=' + str(store), '-S', str(HERE / 'process/worker.uc')]
    processes = []

    def run(mode, path, *instances):
        return subprocess.run(command + [mode, str(path), *instances], capture_output=True, text=True, timeout=15)

    def start(mode, path, *instances):
        proc = subprocess.Popen(command + [mode, str(path), *instances], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(proc)
        return proc

    def ready(proc, path):
        deadline = time.monotonic() + 5
        while not Path(str(path) + '.ready').exists():
            if proc.poll() is not None:
                raise AssertionError(proc.communicate())
            if time.monotonic() > deadline:
                raise AssertionError('worker failed to become ready')
            time.sleep(.01)

    def finish(proc):
        output = proc.communicate(timeout=15)
        if proc.returncode:
            raise AssertionError(output)
        check('contention worker exits successfully', proc.returncode == 0)

    def seed():
        store.write_text(json.dumps({'nordvpn': {n: {'.type': 'instance', 'interface': f'nv_{i}'} for i, n in enumerate(names)},
                                     'network': {'counters': {'.type': 'test'}}}))

    try:
        lock = root / 'owner.lock'
        holder = start('hold', lock)
        ready(holder, lock)
        inode = lock.stat().st_ino
        check('another process cannot steal a live owner', run('try', lock).returncode == 3)
        os.utime(lock, (1, 1))
        lock.write_text('1 1073741824\n')
        check('age and dead-pid text cannot steal live advisory ownership', run('try', lock).returncode == 3)
        holder.kill()
        holder.communicate(timeout=5)
        check('terminated worker releases ownership immediately', run('try', lock).returncode == 0)
        check('recovery retains stable lock inode', lock.stat().st_ino == inode)
        check('delayed old owner release cannot unlock a replacement', run('old_release', lock).returncode == 0)

        inherited = root / 'exec.lock'
        holder = start('hold_exec', inherited)
        ready(holder, inherited)
        child_pid = int(Path(str(inherited) + '.child').read_text())
        holder.kill()
        holder.communicate(timeout=5)
        check('exec child does not retain parent ownership', run('try', inherited).returncode == 0)
        os.kill(child_pid, signal.SIGTERM)

        seed()
        # Different instance owners interleave writes to one package; cached
        # pre-lock cursors would lose the other instance's committed counter.
        one = start('write', root / 'writer_a', names[0])
        two = start('write', root / 'writer_b', names[1])
        finish(one)
        finish(two)
        counters = json.loads(store.read_text())['network']['counters']
        check('fresh protected cursors preserve both instances in one package', all(counters[n] == 30 for n in names))

        seed()
        one = start('reverse', root / 'reverse_a', *names)
        two = start('reverse', root / 'reverse_b', *reversed(names))
        finish(one)
        finish(two)
        counters = json.loads(store.read_text())['network']['counters']
        check('reverse-order multi-instance owners finish without deadlock', all(counters[n] == 30 for n in names))

        # Fan-out never waits interactively. Repeated independent processes
        # either perform one whole callback or return explicit contention.
        fanout = [start('fanout', root / f'fanout_{i}') for i in range(8)]
        outcomes = []
        for proc in fanout:
            output = proc.communicate(timeout=15)
            if proc.returncode not in (0, 3):
                raise AssertionError(output)
            outcomes.append(proc.returncode)
        counters = json.loads(store.read_text())['network']['counters']
        check('credential-style fanout is serialized or explicitly busy', counters['fanout'] == outcomes.count(0) and 3 in outcomes)
    finally:
        for proc in processes:
            if proc.poll() is None:
                proc.kill()
            proc.communicate()
        # All owners are gone; remove only these test-specific stable files.
        for name in names:
            Path('/tmp/nordvpn_operation_' + name + '.lock').unlink(missing_ok=True)
