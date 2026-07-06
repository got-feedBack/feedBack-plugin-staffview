'use strict';
/*
 * Tests for the v3 UI predicate _isV3().
 *
 * _isV3() gates the score-container sizing: v3's #player-hud / #player-controls
 * are position:absolute overlays that consume no layout space, so the container
 * must not subtract their heights. It reads the migrated host global:
 *
 *     window.feedBack && window.feedBack.uiVersion === 'v3'
 *
 * (A companion _playerSlot() helper used to live here too, resolving the v3
 * plugin-control mount point; it was removed along with the ♩ playback pill
 * when alphaSynth playback was dropped — see CHANGELOG "drop alphaSynth
 * playback". Only _isV3() survives, so only it is tested.)
 *
 * Same real-source extraction approach as splitscreen.test.js: pull the
 * function body out of screen.js and compile it with `window` injected —
 * real source, no drift, no jsdom.
 *
 * Run: node --test tests/v3_ui.test.js
 */
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');

function grab(re, label) {
    const m = src.match(re);
    if (!m) throw new Error(`could not extract ${label} from screen.js`);
    return m[0];
}
const isV3Src = grab(/function _isV3\(\) \{[\s\S]*?\n\}/, '_isV3');

// Compile _isV3 with `window` injected; it closes over the injected global.
function load(win) {
    return new Function('window', '"use strict";' + isV3Src + '\nreturn { _isV3 };')(win);
}

// ── _isV3 ────────────────────────────────────────────────────────────────────

test('_isV3 is true when feedBack.uiVersion === "v3"', () => {
    const { _isV3 } = load({ feedBack: { uiVersion: 'v3' } });
    assert.equal(_isV3(), true);
});

test('_isV3 is false when feedBack.uiVersion is "v2"', () => {
    const { _isV3 } = load({ feedBack: { uiVersion: 'v2' } });
    assert.equal(_isV3(), false);
});

test('_isV3 is false when feedBack.uiVersion is absent', () => {
    const { _isV3 } = load({ feedBack: {} });
    assert.equal(_isV3(), false);
});

test('_isV3 is false when the feedBack global itself is missing', () => {
    // Must not throw on window.feedBack.uiVersion when feedBack is undefined.
    const { _isV3 } = load({});
    assert.equal(_isV3(), false);
});

test('_isV3 returns a real boolean (double-bang), not a truthy object', () => {
    const { _isV3 } = load({ feedBack: { uiVersion: 'v3' } });
    assert.strictEqual(_isV3(), true);
    const off = load({ feedBack: undefined });
    assert.strictEqual(off._isV3(), false);
});

test('_isV3 is exact: a "v3"-prefixed version like "v3.1" does not count', () => {
    const { _isV3 } = load({ feedBack: { uiVersion: 'v3.1' } });
    assert.equal(_isV3(), false);
});
