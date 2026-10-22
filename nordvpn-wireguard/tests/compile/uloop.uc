// SPDX-License-Identifier: MIT
// Compile-only namespace for the host interpreter, which has no libubox.
// Never emulate daemon behavior: scheduler tests execute its real functions
// with explicit task/cache adapters in test_runtime_status.uc.
'use strict';
export function init() { die('compile-only uloop adapter'); }
export function interval() { die('compile-only uloop adapter'); }
export function task() { die('compile-only uloop adapter'); }
export function run() { die('compile-only uloop adapter'); }
