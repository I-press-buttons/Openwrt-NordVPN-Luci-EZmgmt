// SPDX-License-Identifier: MIT
// Some shipped uloop versions retain a pipe per completed task. Recycle the
// scheduler before descriptor exhaustion; the WireGuard interface stays up.
//
// The leak: before ucode commit af8a38306 (2026-10-03), uc_uloop_task_clear()
// closed a finished task's output pipe only inside `if (input_fd >= 0)`, and
// input_fd is -1 whenever uloop.task() gets no input callback. Every task
// started without one leaked the pipe's read end (one per probe tick, about
// 120 an hour). Every task therefore gets an input callback: the workers never
// call pipe.receive(), so it is never invoked, but its presence keeps input_fd
// valid and lets the old cleanup close the output pipe as well.
'use strict';
import { lsdir } from 'fs';

function no_input() { return null; }

function create(uloop, options) {
	let opts = options || {}, tasks = [];
	let count = opts.count || function() { return length(lsdir('/proc/self/fd') || []); };
	let recycle = opts.recycle || function() { exit(0); };
	let log = opts.log || function(message) {};
	let limit = opts.limit || 192;
	return {
		start: function(worker, callback) {
			let task = uloop.task(worker, callback, no_input);
			if (!task)
				die('could not start background worker: ' + uloop.error());
			push(tasks, task);
			return task;
		},
		check: function() {
			tasks = filter(tasks, (task) => !task.finished());
			// Never interrupt a refresh, probe, rotation or its rollback.
			if (length(tasks)) return false;
			let descriptors = count();
			if (descriptors < limit) return false;
			log(sprintf('scheduler: recycling after descriptor growth (%d open); tunnel stays up', descriptors));
			recycle();
			return true;
		}
	};
}

return { create };
