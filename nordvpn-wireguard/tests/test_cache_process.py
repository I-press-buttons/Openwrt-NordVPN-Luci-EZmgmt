#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Refresh death recovery and whole-file visibility using real processes/fs."""
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
BASE += ['-S', str(HERE / 'process/cache.uc')]


def check(label, condition):
    if not condition:
        raise AssertionError(label)
    print('ok ' + label, flush=True)


with tempfile.TemporaryDirectory(prefix='nordvpn_cache_') as tmp:
    for phase in ('fetching', 'validating', 'publishing'):
        path = Path(tmp) / phase
        old = '{"generation":"previous"}'
        path.write_text(old)

        def run(mode, *args):
            result = subprocess.run(BASE + [mode, str(path), *args], capture_output=True, text=True, timeout=5)
            if result.returncode:
                raise AssertionError(result.stderr + result.stdout)
            return json.loads(result.stdout)

        child = subprocess.Popen(BASE + ['hold', str(path), phase, str(HERE / 'fixtures/servers_sample.json')],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            marker = Path(str(path) + '.ready')
            deadline = time.monotonic() + 5
            while not marker.exists():
                if child.poll() is not None:
                    raise AssertionError(child.communicate())
                if time.monotonic() >= deadline:
                    raise AssertionError('refresh worker did not reach ' + phase)
                time.sleep(.01)
            job_id = marker.read_text()
            status_path = Path(str(path) + '.status')
            record = json.loads(status_path.read_text())
            record['started_at_epoch'] = 1
            record['started_at_uptime'] = 1
            record['updated_at'] = '1970-01-01T00:00:01Z'
            status_path.write_text(json.dumps(record))
            check('live old refresh stays running in ' + phase, run('status', job_id)['state'] == 'running')
            duplicate = run('reserve')
            check('concurrent refresh deduplicates in ' + phase,
                  duplicate['already_running'] and duplicate['apply']['id'] == job_id)
            child.kill()
            child.communicate(timeout=5)
            result = run('status', job_id)
            check('worker death recovers ' + phase, result['state'] == 'failed' and result['progress']['phase'] == phase)
            check('death before replacement preserves bytes in ' + phase, path.read_text() == old)
            check('dead refresh permits new reservation in ' + phase, run('reserve')['started'])
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)
    path = Path(tmp) / 'readers'
    path.write_text(json.dumps({'generation': 'old', 'padding': 'x' * 10000}))
    writer = subprocess.Popen(BASE + ['publish', str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    reads = 0
    while writer.poll() is None:
        value = json.loads(path.read_text())
        check_generation = value['generation'] in ('old', 'new') and value['padding'] == 'x' * 10000
        if not check_generation:
            raise AssertionError('partial replacement reached reader')
        reads += 1
    output, errors = writer.communicate(timeout=5)
    check('concurrent readers see complete generations', writer.returncode == 0 and reads > 0)
