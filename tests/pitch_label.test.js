'use strict';
/*
 * Tests for the pure pitch-label helper _svPitchLabel(note), backing the
 * note explorer's alt+click / double-tap tooltip.
 *
 * Returns 'En / Sol' (e.g. 'C#4 / DO#4'). Spelling is driven by
 * note.accidentalMode (alphaTab AccidentalMode enum: Default=0 ForceNone=1
 * ForceNatural=2 ForceSharp=3 ForceDoubleSharp=4 ForceFlat=5
 * ForceDoubleFlat=6); Default/ForceNone fall back to the key signature
 * (positive/zero = sharp spelling, negative = flat spelling).
 *
 * No DOM/window dependency — extract the real source (the four pitch
 * tables + the function) from screen.js and compile it directly. Same
 * extraction approach as zoom.test.js.
 *
 * Run: node --test tests/pitch_label.test.js
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

const tables = [
    grab(/^const _SV_NOTE_EN_S\s*=.*$/m, '_SV_NOTE_EN_S'),
    grab(/^const _SV_NOTE_SOL_S\s*=.*$/m, '_SV_NOTE_SOL_S'),
    grab(/^const _SV_NOTE_EN_F\s*=.*$/m, '_SV_NOTE_EN_F'),
    grab(/^const _SV_NOTE_SOL_F\s*=.*$/m, '_SV_NOTE_SOL_F'),
].join('\n');
const fnSrc = grab(/function _svPitchLabel\(note\) \{[\s\S]*?\n\}/, '_svPitchLabel');

function load() {
    return new Function('"use strict";' + tables + '\n' + fnSrc + '\nreturn { _svPitchLabel };')();
}
const { _svPitchLabel } = load();

// Builds a minimal note-like object from a MIDI pitch, deriving tone and
// octave EXACTLY as the score builder does (tone = midi%12,
// octave = floor(midi/12)) so the tests exercise the real octave convention
// rather than a pre-cooked octave. The label must read scientific-pitch
// notation (middle C, MIDI 60, = C4). `ks` is threaded through the
// note.beat.voice.bar.masterBar.keySignature chain the real function reads.
function note(midi, accidentalMode, ks) {
    return {
        tone: midi % 12,
        octave: Math.floor(midi / 12),
        accidentalMode,
        beat: { voice: { bar: { masterBar: { keySignature: ks } } } },
    };
}
// MIDI reference: C4=60 C#4=61 D4=62 C5=72 A2=45 A4=69 A6=93 A0=21 C8=108.

// ── Scientific octave convention (regression: builder octave floor(midi/12)
//    must print as octave-1) ─────────────────────────────────────────────────

test('middle C (MIDI 60) labels as C4, not C5', () => {
    assert.equal(_svPitchLabel(note(60, 0, 0)), 'C4 / DO4');
});

test('lowest piano A (MIDI 21) labels as A0', () => {
    assert.equal(_svPitchLabel(note(21, 0, 0)), 'A0 / LA0');
});

test('highest piano C (MIDI 108) labels as C8', () => {
    assert.equal(_svPitchLabel(note(108, 0, 0)), 'C8 / DO8');
});

// ── Default/ForceNone spelling — key-signature fallback ─────────────────────

test('default spelling (am=0) with ks=0 uses sharp names', () => {
    assert.equal(_svPitchLabel(note(61, 0, 0)), 'C#4 / DO#4');
});

test('default spelling (am=0) with positive ks uses sharp names', () => {
    assert.equal(_svPitchLabel(note(61, 0, 3)), 'C#4 / DO#4');
});

test('default spelling (am=0) with negative ks uses flat names', () => {
    assert.equal(_svPitchLabel(note(61, 0, -2)), 'Db4 / REb4');
});

test('ForceNone (am=1) falls back to the same key-signature spelling as Default', () => {
    assert.equal(_svPitchLabel(note(61, 1, -2)), 'Db4 / REb4');
});

test('accidentalMode absent (undefined) behaves like Default(0)', () => {
    assert.equal(_svPitchLabel(note(61, undefined, 0)), 'C#4 / DO#4');
});

test('missing note.beat chain defaults ks to 0 without throwing', () => {
    const n = { tone: 1, octave: 5, accidentalMode: 0 }; // no .beat at all
    assert.equal(_svPitchLabel(n), 'C#4 / DO#4');
});

// ── Force* accidental overrides ──────────────────────────────────────────────

test('ForceSharp (am=3) uses sharp names regardless of a flat key signature', () => {
    assert.equal(_svPitchLabel(note(61, 3, -5)), 'C#4 / DO#4');
});

test('ForceFlat (am=5) uses flat names regardless of a sharp key signature', () => {
    assert.equal(_svPitchLabel(note(61, 5, 5)), 'Db4 / REb4');
});

test('ForceNatural (am=2) appends the natural sign to sharp-table spelling', () => {
    assert.equal(_svPitchLabel(note(60, 2, 0)), 'C♮4 / DO♮4');
});

test('ForceDoubleSharp (am=4) uses the double-sharp table for a diatonic-adjacent tone', () => {
    assert.equal(_svPitchLabel(note(62, 4, 0)), 'C##4 / DO##4');
});

test('ForceDoubleSharp (am=4) falls back to sharp-table+(##) suffix for a tone absent from the table', () => {
    // tone 0 (C) has no entry in the double-sharp table (null).
    assert.equal(_svPitchLabel(note(60, 4, 0)), 'C(##)4 / DO(##)4');
});

test('ForceDoubleFlat (am=6) uses the double-flat table for a diatonic-adjacent tone', () => {
    assert.equal(_svPitchLabel(note(60, 6, 0)), 'Dbb4 / REbb4');
});

test('ForceDoubleFlat (am=6) falls back to flat-table+(bb) suffix for a tone absent from the table', () => {
    // tone 1 (C#/Db) has no entry in the double-flat table (null).
    assert.equal(_svPitchLabel(note(61, 6, 0)), 'Db(bb)4 / REb(bb)4');
});

// ── Octave and natural-tone passthrough ──────────────────────────────────────

test('a natural (non-accidental) tone is spelled identically in both tables', () => {
    assert.equal(_svPitchLabel(note(72, 0, 0)), 'C5 / DO5');   // sharp branch
    assert.equal(_svPitchLabel(note(72, 0, -1)), 'C5 / DO5');  // flat branch
});

test('octave is corrected on both the En and Sol names', () => {
    assert.equal(_svPitchLabel(note(45, 0, 0)), 'A2 / LA2');
    assert.equal(_svPitchLabel(note(93, 0, 0)), 'A6 / LA6');
});
