'use strict';
/*
 * Tests for the v3 UI helpers _isV3() and _playerSlot().
 *
 * _isV3() gates the score-container sizing: v3's #player-hud / #player-controls
 * are position:absolute overlays that consume no layout space, so the container
 * must not subtract their heights. It reads the migrated host global:
 *
 *     window.feedBack && window.feedBack.uiVersion === 'v3'
 *
 * _playerSlot() resolves the v3 plugin-control mount point
 * (window.feedBack.ui.playerControlSlot()) that the options pill (LAYOUT/ZOOM
 * controls) mounts into on v3; it returns null on v2 so callers fall back to
 * #player-footer. It was removed along with the old ♩ playback pill when
 * alphaSynth playback was dropped, then reintroduced when the pill came back
 * with real (non-playback) content — see CHANGELOG "reintroduce options pill".
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
const isV3Src      = grab(/function _isV3\(\) \{[\s\S]*?\n\}/, '_isV3');
const playerSlotSrc = grab(/function _playerSlot\(\) \{[\s\S]*?\n\}/, '_playerSlot');

// Compile both with `window` injected; _playerSlot() calls _isV3() by name,
// so both must be defined in the same Function body for the reference to
// resolve — same technique, just two functions instead of one.
function load(win) {
    return new Function('window', '"use strict";'
        + isV3Src + '\n' + playerSlotSrc
        + '\nreturn { _isV3, _playerSlot };')(win);
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

// ── _playerSlot ──────────────────────────────────────────────────────────────

test('_playerSlot returns the slot element on v3 when playerControlSlot() is present', () => {
    const slotEl = { id: 'v3-plugin-controls-slot' };
    const { _playerSlot } = load({
        feedBack: { uiVersion: 'v3', ui: { playerControlSlot: () => slotEl } },
    });
    assert.equal(_playerSlot(), slotEl);
});

test('_playerSlot returns null on v2 without calling playerControlSlot()', () => {
    let called = false;
    const { _playerSlot } = load({
        feedBack: { uiVersion: 'v2', ui: { playerControlSlot: () => { called = true; return {}; } } },
    });
    assert.equal(_playerSlot(), null);
    assert.equal(called, false);
});

test('_playerSlot returns null on v3 when feedBack.ui is absent', () => {
    const { _playerSlot } = load({ feedBack: { uiVersion: 'v3' } });
    assert.equal(_playerSlot(), null);
});

test('_playerSlot returns null on v3 when playerControlSlot is not a function', () => {
    const { _playerSlot } = load({
        feedBack: { uiVersion: 'v3', ui: { playerControlSlot: 'not-a-fn' } },
    });
    assert.equal(_playerSlot(), null);
});

test('_playerSlot returns null when the feedBack global itself is missing', () => {
    const { _playerSlot } = load({});
    assert.equal(_playerSlot(), null);
});
