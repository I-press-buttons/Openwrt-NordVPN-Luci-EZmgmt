// SPDX-License-Identifier: MIT
// Some shipped uloop versions retain a pipe per completed task. Recycle the
// scheduler before descriptor exhaustion; the WireGuard interface stays up.
'use strict';
import { lsdir } from 'fs';

function create(uloop, options) {
	let opts = options || {}, tasks = [];
	let count = opts.count || function() { return length(lsdir('/proc/self/fd') || []); };
	let recycle = opts.recycle || function() { exit(0); };
	let log = opts.log || function(message) {};
	let limit = opts.limit || 192;
	return {
		start: function(worker, callback) {
			let task = uloop.task(worker, callback);
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
