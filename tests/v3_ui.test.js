'use strict';
/*
 * Tests for the v3 UI predicates _isV3() and _playerSlot().
 *
 * _isV3() gates two things: where the ♩ pill mounts (the plugin-control slot
 * vs the v2 footer) and whether the score container subtracts the v2
 * HUD/controls heights. It reads the migrated host global:
 *
 *     window.feedBack && window.feedBack.uiVersion === 'v3'
 *
 * _playerSlot() resolves the v3 plugin-control mount point via
 *     window.feedBack.ui.playerControlSlot()
 * returning null on v2 (or when the slot API isn't present) so callers fall
 * back to the v2 footer unchanged.
 *
 * NOTE ON PR INTERACTION: _playerSlot() (and the pill it feeds) is DELETED by
 * the alphaSynth-removal PR (#4). If #4 lands first and this branch is rebased
 * onto it, _playerSlot() will be gone from screen.js — so its tests here
 * auto-skip when the function can't be found, rather than failing the file.
 * _isV3() survives both PRs (the container-inset path still needs it), so its
 * tests are unconditional.
 *
 * Same real-source extraction approach as splitscreen.test.js: pull the
 * function bodies out of screen.js and compile them with `window` injected —
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
function grabOptional(re) {
    const m = src.match(re);
    return m ? m[0] : null;
}

// _isV3() is durable across PRs #4/#5; _playerSlot() is removed by #4.
const isV3Src = grab(/function _isV3\(\) \{[\s\S]*?\n\}/, '_isV3');
const playerSlotSrc = grabOptional(/function _playerSlot\(\) \{[\s\S]*?\n\}/);

// _playerSlot() calls _isV3(), so compile both together and hand back whichever
// exist. `window` is injected; both functions close over it.
function load(win) {
    const body =
        '"use strict";' + isV3Src +
        (playerSlotSrc ? '\n' + playerSlotSrc : '') +
        '\nreturn { _isV3, _playerSlot: typeof _playerSlot === "function" ? _playerSlot : undefined };';
    return new Function('window', body)(win);
}

// Skip reason string when _playerSlot has been removed (post-#4 rebase).
const slotSkip = playerSlotSrc ? false : '_playerSlot() removed by pill-removal PR #4';

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

// ── _playerSlot (skips if removed by #4) ─────────────────────────────────────

test('_playerSlot returns null on v2 (no slot on the v2 footer path)', { skip: slotSkip }, () => {
    const { _playerSlot } = load({ feedBack: { uiVersion: 'v2', ui: { playerControlSlot: () => ({}) } } });
    assert.equal(_playerSlot(), null);
});

test('_playerSlot returns the slot element on v3 when the slot API is present', { skip: slotSkip }, () => {
    const slotEl = { id: 'plugin-control-slot' };
    const { _playerSlot } = load({
        feedBack: { uiVersion: 'v3', ui: { playerControlSlot: () => slotEl } },
    });
    assert.equal(_playerSlot(), slotEl);
});

test('_playerSlot returns null on v3 when feedBack.ui is missing', { skip: slotSkip }, () => {
    // v3 detected but the host exposes no ui object yet — must not throw.
    const { _playerSlot } = load({ feedBack: { uiVersion: 'v3' } });
    assert.equal(_playerSlot(), null);
});

test('_playerSlot returns null on v3 when playerControlSlot is not a function', { skip: slotSkip }, () => {
    const { _playerSlot } = load({ feedBack: { uiVersion: 'v3', ui: { playerControlSlot: 'nope' } } });
    assert.equal(_playerSlot(), null);
});

test('_playerSlot passes the slot through verbatim (may be null when the rail has no slot yet)', { skip: slotSkip }, () => {
    // A v3 host whose slot isn't mounted yet returns null from playerControlSlot;
    // _playerSlot must forward that null, letting the caller's retry path run.
    const { _playerSlot } = load({
        feedBack: { uiVersion: 'v3', ui: { playerControlSlot: () => null } },
    });
    assert.equal(_playerSlot(), null);
});
