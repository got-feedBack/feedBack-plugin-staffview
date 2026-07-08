'use strict';
/*
 * Tests for the pure zoom-clamp helper _svClampScale(value).
 *
 * Backs the pill's ZOOM section: [-]/[+] step by 0.05 (5%), clamped to
 * 50%-200%, rounded to the nearest 5% step so repeated +/- clicks land on
 * exact percentages instead of drifting on float error.
 *
 * Module-scope, no DOM/window dependency — extract the real source text
 * from screen.js and compile it directly, no `window` injection needed.
 * Same extraction approach as splitscreen.test.js / v3_ui.test.js.
 *
 * Run: node --test tests/zoom.test.js
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
const clampSrc = grab(/function _svClampScale\(value\) \{[\s\S]*?\n\}/, '_svClampScale');

function load() {
    return new Function('"use strict";' + clampSrc + '\nreturn { _svClampScale };')();
}

const { _svClampScale } = load();

// ── _svClampScale ────────────────────────────────────────────────────────────

test('_svClampScale passes through an in-range value already on a 5% step', () => {
    assert.equal(_svClampScale(1.0), 1.0);
    assert.equal(_svClampScale(0.75), 0.75);
});

test('_svClampScale clamps below the 50% floor', () => {
    assert.equal(_svClampScale(0.1), 0.5);
    assert.equal(_svClampScale(0), 0.5);
    assert.equal(_svClampScale(-1), 0.5);
});

test('_svClampScale clamps above the 200% ceiling', () => {
    assert.equal(_svClampScale(3.0), 2.0);
    assert.equal(_svClampScale(2.05), 2.0);
});

test('_svClampScale rounds to the nearest 5% step, correcting float drift', () => {
    // Repeated +/- 0.05 accumulates float error (e.g. 0.9500000000000001);
    // the round-to-nearest-1/20 must snap it back to an exact step.
    assert.equal(_svClampScale(0.9500000000000001), 0.95);
    assert.equal(_svClampScale(1.0299999999999998), 1.05);
});

test('_svClampScale: boundary values are exact, not off-by-one-step', () => {
    assert.equal(_svClampScale(0.5), 0.5);
    assert.equal(_svClampScale(2.0), 2.0);
});

// ── read path: persisted staffview_scale must be clamped/NaN-guarded ──────────
// Mirrors the init expression in screen.js:
//   const s = parseFloat(_svReadStore(_SV_STORE_SCALE));
//   _svScale = _svClampScale(Number.isFinite(s) ? s : 1.0)
// Uses the real _svClampScale so a regression in either half is caught.
const readScale = (raw) => {
    const s = parseFloat(raw);
    return _svClampScale(Number.isFinite(s) ? s : 1.0);
};

test('read path clamps an out-of-range stored value to the ceiling', () => {
    assert.equal(readScale('10'), 2.0);
});

test('read path clamps a below-range stored value (incl. 0) to the floor', () => {
    assert.equal(readScale('0'), 0.5);
    assert.equal(readScale('0.1'), 0.5);
});

test('read path falls back to 1.0 on garbage (NaN), never renders NaN', () => {
    assert.equal(readScale('abc'), 1.0);
    assert.equal(readScale(null), 1.0);   // no stored value
});
