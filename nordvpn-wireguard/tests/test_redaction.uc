// SPDX-License-Identifier: MIT
'use strict';
const common = require('nordvpn.common');
const history = require('nordvpn.history');
let failures = 0;
function ok(label, value) { printf('%s %s\n', value ? 'ok' : 'FAIL', label); if (!value) failures++; }
const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const keys = [
 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
 '///////////////////////////////////////////=',
 '+++++++++++++++++++++++++++++++++++++++++++='
];
for (let key in keys) {
 ok('synthetic key has WireGuard length', length(key) == 44);
 let message = 'first=' + key + '\nsecond=' + key + ' token=' + token;
 let scrubbed = common.redact(message);
 ok('all key occurrences redacted including slash/plus alphabet', index(scrubbed, key) < 0 && index(scrubbed, '<redacted-key>') >= 0);
 ok('mixed message also scrubs tokens', index(scrubbed, token) < 0 && index(scrubbed, '<redacted-token>') >= 0);
 let event = history.make_event('connect_failed', { error: message }, 1);
 ok('event history cannot retain key or token', index(sprintf('%J', event), key) < 0 && index(sprintf('%J', event), token) < 0);
}
ok('normal operational messages survive', common.redact('main connected to us14303.nordvpn.com') == 'main connected to us14303.nordvpn.com');
ok('non-string input is unchanged', common.redact(null) == null);
exit(failures ? 1 : 0);
