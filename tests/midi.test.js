'use strict';
/*
 * Tests for the pure MIDI byte-parsing helper _svParseMidiMessage(data,
 * savedCh), backing _svMidiOnMessage's dispatch to _handleNoteOn/
 * _handleNoteOff/_handleSustain.
 *
 * No DOM/window dependency — extract the real source from screen.js and
 * compile it directly. Same extraction approach as zoom.test.js.
 *
 * Run: node --test tests/midi.test.js
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

const fnSrc = grab(/function _svParseMidiMessage\(data, savedCh\) \{[\s\S]*?\n\}/, '_svParseMidiMessage');

function load() {
    return new Function('"use strict";' + fnSrc + '\nreturn { _svParseMidiMessage };')();
}
const { _svParseMidiMessage } = load();

// _svNdReport: compiled standalone with window/ND_PROVIDER_ID injected.
const ndReportSrc = grab(/function _svNdReport\(hit, midi, bindingId\) \{[\s\S]*?\n\}/, '_svNdReport');
function loadNdReport(win) {
    return new Function('window', 'ND_PROVIDER_ID',
        '"use strict";' + ndReportSrc + '\nreturn _svNdReport;')(win, 'staffview');
}

// Status byte builders. Channel is the low nibble (0-15).
const noteOn  = (ch, note, vel) => [0x90 | ch, note, vel];
const noteOff = (ch, note, vel) => [0x80 | ch, note, vel === undefined ? 64 : vel];
const cc      = (ch, controller, value) => [0xB0 | ch, controller, value];

// ── Note On / Note Off ────────────────────────────────────────────────────

test('Note On with velocity > 0 parses to a noteOn event', () => {
    assert.deepEqual(_svParseMidiMessage(noteOn(0, 60, 100), -1), { type: 'noteOn', note: 60, velocity: 100 });
});

test('Note On with velocity === 0 is treated as Note Off (running-status convention)', () => {
    assert.deepEqual(_svParseMidiMessage(noteOn(0, 60, 0), -1), { type: 'noteOff', note: 60 });
});

test('Note Off (0x8n) parses to a noteOff event regardless of its velocity byte', () => {
    assert.deepEqual(_svParseMidiMessage(noteOff(0, 60, 127), -1), { type: 'noteOff', note: 60 });
});

// ── Sustain (CC64) ───────────────────────────────────────────────────────

test('CC64 with value >= 64 parses to sustain down=true', () => {
    assert.deepEqual(_svParseMidiMessage(cc(0, 64, 100), -1), { type: 'sustain', down: true });
});

test('CC64 with value < 64 parses to sustain down=false', () => {
    assert.deepEqual(_svParseMidiMessage(cc(0, 64, 30), -1), { type: 'sustain', down: false });
});

test('a different CC controller (not 64) is ignored', () => {
    assert.equal(_svParseMidiMessage(cc(0, 7, 100), -1), null);
});

// ── Channel filtering ────────────────────────────────────────────────────

test('savedCh = -1 (All channels) accepts a message on any channel', () => {
    assert.notEqual(_svParseMidiMessage(noteOn(5, 60, 100), -1), null);
    assert.notEqual(_svParseMidiMessage(noteOn(15, 60, 100), -1), null);
});

test('savedCh >= 0 rejects a message on a different channel', () => {
    assert.equal(_svParseMidiMessage(noteOn(2, 60, 100), 5), null);
});

test('savedCh >= 0 accepts a message on the matching channel', () => {
    assert.deepEqual(_svParseMidiMessage(noteOn(5, 60, 100), 5), { type: 'noteOn', note: 60, velocity: 100 });
});

// ── Malformed / irrelevant input ─────────────────────────────────────────

test('returns null for data shorter than 2 bytes', () => {
    assert.equal(_svParseMidiMessage([0x90], -1), null);
    assert.equal(_svParseMidiMessage([], -1), null);
});

test('returns null for missing/undefined data', () => {
    assert.equal(_svParseMidiMessage(null, -1), null);
    assert.equal(_svParseMidiMessage(undefined, -1), null);
});

test('returns null for an unrecognized command (e.g. pitch bend 0xE0)', () => {
    assert.equal(_svParseMidiMessage([0xE0, 0, 64], -1), null);
});

// ── _svNdReport: methods must be called bound to `nd` ─────────────────────
// The timebase-rebuild fix (#1) needs the host/DOM to exercise, so it isn't
// unit-tested here. This pins the bind fix (#2): reportHit/reportMiss are
// invoked with `nd` as receiver, so `this` is defined inside them.

function ndMock() {
    const calls = [];
    const record = (name) => function (payload) { calls.push({ name, self: this, payload }); };
    const nd = { version: 1, reportHit: record('reportHit'), reportMiss: record('reportMiss') };
    return { window: { feedBack: { noteDetection: nd } }, nd, calls };
}

test('_svNdReport calls reportHit bound to nd (this === nd)', () => {
    const { window, nd, calls } = ndMock();
    loadNdReport(window)(true, 60, 'bind-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'reportHit');
    assert.equal(calls[0].self, nd);   // fails if the method is detached
    assert.deepEqual(calls[0].payload, { bindingId: 'bind-1', providerId: 'staffview', midi: 60, hit: true });
});

test('_svNdReport calls reportMiss bound to nd (this === nd)', () => {
    const { window, nd, calls } = ndMock();
    loadNdReport(window)(false, 62, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'reportMiss');
    assert.equal(calls[0].self, nd);
    assert.equal(calls[0].payload.hit, false);
});

test('defaults velocity to 0 when the third byte is absent (2-byte message)', () => {
    // A 2-byte "note on" with no velocity byte at all degrades to noteOff
    // (velocity defaults to 0), matching the running-status convention.
    assert.deepEqual(_svParseMidiMessage([0x90, 60], -1), { type: 'noteOff', note: 60 });
});
