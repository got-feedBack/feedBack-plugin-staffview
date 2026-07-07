'use strict';
/*
 * Tests for the pure accuracy helper _svAccuracyPct(hits, misses).
 *
 * Backs the supplementary score badge and mirrors core's scoring formula
 * (lib/song_score.py): accuracy = hits / max(1, hits + misses), expressed
 * here as a percentage. Zero judged notes yields 0 (not NaN) so the badge
 * never renders a divide-by-zero.
 *
 * Module-scope, no DOM/window dependency — extract the real source text
 * from screen.js and compile it directly. Same extraction approach as
 * zoom.test.js / midi.test.js.
 *
 * Run: node --test tests/score.test.js
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
const accSrc = grab(/function _svAccuracyPct\(hits, misses\) \{[\s\S]*?\n    \}/, '_svAccuracyPct');

function load() {
    return new Function('"use strict";' + accSrc + '\nreturn { _svAccuracyPct };')();
}

const { _svAccuracyPct } = load();

// ── _svAccuracyPct ───────────────────────────────────────────────────────────

test('_svAccuracyPct is 0 when nothing has been judged (no divide-by-zero)', () => {
    assert.equal(_svAccuracyPct(0, 0), 0);
});

test('_svAccuracyPct is 100 for all hits, 0 for all misses', () => {
    assert.equal(_svAccuracyPct(10, 0), 100);
    assert.equal(_svAccuracyPct(0, 5), 0);
});

test('_svAccuracyPct matches hits / (hits + misses) * 100', () => {
    assert.equal(_svAccuracyPct(3, 1), 75);
    assert.equal(_svAccuracyPct(1, 3), 25);
    assert.equal(_svAccuracyPct(1, 1), 50);
});

test('_svAccuracyPct returns a real number for non-terminating ratios', () => {
    // 2/3 → 66.666…%; the badge rounds for display, the helper does not.
    assert.ok(Math.abs(_svAccuracyPct(2, 1) - (2 / 3) * 100) < 1e-9);
});
