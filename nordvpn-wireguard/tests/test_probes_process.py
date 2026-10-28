#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Delayed worker and generation races across real processes, without HTTP."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
BASE = [os.environ.get('UCODE', 'ucode'), '-L', str(HERE / 'mocks/*.uc'),
        '-L', str(HERE.parent / 'files/usr/share/ucode/*.uc')]
if os.environ.get('UCODE_EXTRA_L'):
    BASE += ['-L', os.environ['UCODE_EXTRA_L']]
BASE += ['-S', str(HERE / 'process/probes.uc')]


def check(label, condition):
    if not condition:
        raise AssertionError(label)
    print('ok ' + label, flush=True)


with tempfile.TemporaryDirectory(prefix='nordvpn_probes_') as tmp:
    path = Path(tmp) / 'probe'
    marker = Path(str(path) + '.ready')
    release = Path(str(path) + '.release')

    def run(mode, *args):
        result = subprocess.run(BASE + [mode, str(path), *args], capture_output=True, text=True, timeout=3)
        if result.returncode:
            raise AssertionError(result.stderr + result.stdout)
        return json.loads(result.stdout)

    def ready(child):
        deadline = time.monotonic() + 3
        while not marker.exists():
            if child.poll() is not None:
                raise AssertionError(child.communicate())
            if time.monotonic() >= deadline:
                raise AssertionError('probe worker failed to become ready')
            time.sleep(.01)
        return marker.read_text()

    child = subprocess.Popen(BASE + ['hold', str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        job_id = ready(child)
        cache_path, job_path = Path(str(path) + '.cache'), Path(str(path) + '.job')
        before = (cache_path.read_bytes(), job_path.read_bytes())
        started = time.monotonic()
        check('delayed worker leaves status RPC responsive', run('status', job_id)['state'] == 'pending' and time.monotonic() - started < 1)
        check('second tab shares delayed worker exact ID', run('start')['id'] == job_id)
        check('status and dedupe leave observation/job bytes unchanged', before == (cache_path.read_bytes(), job_path.read_bytes()))
        check('mutation can acquire ownership during delayed HTTP', run('invalidate')['ok'])
        release.touch()
        stdout, stderr = child.communicate(timeout=3)
        check('late process result is rejected after reconnect', child.returncode == 0 and json.loads(stdout)['error'] == 'probe generation superseded')
        check('superseded process publishes no protected observation', not json.loads(cache_path.read_text())['records'])
        marker.unlink()
        release.unlink()
        child = subprocess.Popen(BASE + ['hold', str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        job_id = ready(child)
        child.kill()
        child.communicate(timeout=3)
        before = (cache_path.read_bytes(), job_path.read_bytes())
        check('SIGKILL is visible through read-only exact-ID status', run('status', job_id)['state'] == 'failed')
        check('dead-worker read does not recover/write status', before == (cache_path.read_bytes(), job_path.read_bytes()))
        retry = run('start')
        check('dead worker enters bounded retry backoff', retry['state'] == 'failed' and retry['backoff'] and 0 < retry['retry_after_seconds'] <= 30)
        check('other-instance ID cannot satisfy a watcher', run('status', 'other-job')['state'] == 'missing')
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate(timeout=3)
