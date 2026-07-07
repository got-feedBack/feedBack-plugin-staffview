'use strict';
/*
 * Tests for the pure study-mode helper _svMidiToDiatonic(midi).
 *
 * Maps a MIDI note number to a diatonic staff-step index (C-major), used to
 * place a wrong-note X at its true pitch and to draw clef-aware ledger lines.
 * The draw code relies on two anchor values: treble staff bottom = E4 = 30,
 * bass staff bottom = G2 = 18; each octave is 7 diatonic steps.
 *
 * Module-scope, no DOM/window dependency — extract the real source text from
 * screen.js and compile it directly. Same extraction approach as zoom.test.js.
 *
 * Run: node --test tests/study.test.js
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
const fnSrc = grab(/function _svMidiToDiatonic\(midi\) \{[\s\S]*?\n    \}/, '_svMidiToDiatonic');

function load() {
    return new Function('"use strict";' + fnSrc + '\nreturn { _svMidiToDiatonic };')();
}
const { _svMidiToDiatonic } = load();

// ── _svMidiToDiatonic ────────────────────────────────────────────────────────

test('_svMidiToDiatonic matches the draw code anchors (E4=30 treble, G2=18 bass)', () => {
    assert.equal(_svMidiToDiatonic(64), 30);   // E4 — treble staff bottom
    assert.equal(_svMidiToDiatonic(43), 18);   // G2 — bass staff bottom
});

test('_svMidiToDiatonic ignores accidentals (C4 and C#4 share a step)', () => {
    assert.equal(_svMidiToDiatonic(60), _svMidiToDiatonic(61));   // C4 == C#4
    assert.equal(_svMidiToDiatonic(60), 28);                      // C4
    assert.equal(_svMidiToDiatonic(62), 29);                      // D4
});

test('_svMidiToDiatonic advances 7 steps per octave', () => {
    assert.equal(_svMidiToDiatonic(72) - _svMidiToDiatonic(60), 7);   // C5 − C4
    assert.equal(_svMidiToDiatonic(48) - _svMidiToDiatonic(60), -7);  // C3 − C4
});
