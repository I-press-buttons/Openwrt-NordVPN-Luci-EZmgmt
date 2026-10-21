#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Exercise real job ownership release after SIGKILL, without device services."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
BASE = [os.environ.get('UCODE', 'ucode'), '-L', str(HERE / 'process/*.uc'),
        '-L', str(HERE.parent / 'files/usr/share/ucode/*.uc')]
if os.environ.get('UCODE_EXTRA_L'):
    BASE += ['-L', os.environ['UCODE_EXTRA_L']]
BASE += ['-S', str(HERE / 'process/jobs.uc')]


def check(label, condition):
    if not condition:
        raise AssertionError(label)
    print('ok ' + label, flush=True)


with tempfile.TemporaryDirectory(prefix='nordvpn_jobs_') as tmp:
    path = Path(tmp) / 'status.json'

    def run(mode, *args):
        result = subprocess.run(BASE + [mode, str(path), *args], capture_output=True, text=True, timeout=5)
        if result.returncode:
            raise AssertionError(result.stderr + result.stdout)
        return json.loads(result.stdout)

    child = subprocess.Popen(BASE + ['hold', str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        marker = Path(str(path) + '.ready')
        deadline = time.monotonic() + 5
        while not marker.exists():
            if child.poll() is not None:
                raise AssertionError(child.communicate())
            if time.monotonic() >= deadline:
                raise AssertionError('job worker failed to become ready')
            time.sleep(.01)
        job_id = marker.read_text()
        running = run('status', job_id)
        check('real worker owns a running reservation', running['phase'] == 'running' and running['id'] == job_id)
        duplicate = run('reserve')
        check('concurrent process deduplicates exact running ID', duplicate['already_running'] and duplicate['apply']['id'] == job_id)
        inode = Path(str(path) + '.execution.lock').stat().st_ino
        child.kill()
        child.communicate(timeout=5)
        failed = run('status', job_id)
        check('SIGKILL becomes an explicit terminal failure', failed['state'] == 'failed' and failed['stale'])
        check('replacement worker claims released advisory slot', run('complete')['state'] == 'success')
        check('replacement retains stable execution lock inode', Path(str(path) + '.execution.lock').stat().st_ino == inode)
        check('exact old result survives replacement process', run('status', job_id)['state'] == 'failed')
        check('unknown exact ID cannot receive replacement success', run('status', 'unknown')['state'] == 'missing')
        path.unlink()
        path.mkdir()
        check('real status replacement failure refuses launch', 'storage' in run('reserve')['error'])
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate(timeout=5)
