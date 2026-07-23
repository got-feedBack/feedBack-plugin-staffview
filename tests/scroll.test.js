'use strict';
/*
 * Tests for the 1-row lookahead auto-scroll in _svUpdateMarker.
 *
 * The point of the lookahead: the next staff system becomes visible while the
 * player is still on the current row, instead of the cursor reaching the
 * bottom edge first. Study mode drives the same marker (_svStudySnapCursor →
 * _svUpdateMarker), so it must scroll identically — study mode is a cursor
 * *source*, not a separate render path. The last test runs the study path for
 * real and asserts it lands on the same scroll target.
 *
 * Module-scope extraction like study.test.js/zoom.test.js: pull the real
 * function text out of screen.js and compile it with stubbed module globals.
 *
 * Run: node --test tests/scroll.test.js
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
const markerSrc = grab(/function _svUpdateMarker\(\) \{[\s\S]*?\n    \}/, '_svUpdateMarker');
const snapSrc   = grab(/function _svStudySnapCursor\(\) \{[\s\S]*?\n    \}/, '_svStudySnapCursor');

const VIEW_W = 800;
const VIEW_H = 400;
const ROW_H  = 120;
// Four rows, 150px apart: two rows fit in a 400px viewport, so "reveal the
// next row" is a meaningful thing to ask for.
const SYSTEMS = [0, 150, 300, 450].map(y => ({ visualBounds: { y, h: ROW_H } }));
// x well clear of padX (=180) at both edges, so the horizontal rule stays out
// of the way and every scrollTo below is the vertical decision alone.
const BEAT_X = 400;

function harness({ scrollTop = 0, isHoriz = false }) {
    const calls = [];
    const marker    = { style: {} };
    const container = {
        clientWidth: VIEW_W, clientHeight: VIEW_H,
        scrollLeft: 0, scrollTop,
        scrollTo(o) { calls.push(o); },
    };
    // The beat object is the row index; findBeat maps it back to bounds.
    const api = {
        boundsLookup: {
            staffSystems: SYSTEMS,
            findBeat: (beat) => ({
                visualBounds: { x: BEAT_X, y: SYSTEMS[beat.row].visualBounds.y + 10, w: 6, h: 40 },
            }),
        },
    };
    return { calls, marker, container, api, isHoriz };
}

// Normal playback: cursor set directly, then the marker updated.
function runPlayback({ rowIdx, scrollTop = 0, isHoriz = false }) {
    const h = harness({ scrollTop, isHoriz });
    new Function(
        '_svMarker', '_svContainer', '_svAtMount', '_svApi', '_svLastBeat', '_svLayoutIsHoriz',
        '"use strict";' + markerSrc + '\nreturn _svUpdateMarker;',
    )(h.marker, h.container, { offsetLeft: 0, offsetTop: 0 }, h.api, { row: rowIdx }, h.isHoriz)();
    return h.calls;
}

// Study mode: cursor comes from the gate list via _svStudySnapCursor.
function runStudy({ rowIdx, scrollTop = 0 }) {
    const h = harness({ scrollTop });
    const gates = [{ entries: [{ beat: { row: rowIdx } }] }];
    new Function(
        '_svMarker', '_svContainer', '_svAtMount', '_svApi', '_svLastBeat', '_svLayoutIsHoriz',
        '_svStudyGateIdx', '_svStudyGates',
        '"use strict";' + markerSrc + '\n' + snapSrc + '\nreturn _svStudySnapCursor;',
    )(h.marker, h.container, { offsetLeft: 0, offsetTop: 0 }, h.api, null, false, 0, gates)();
    return h.calls;
}

// ── the lookahead itself ─────────────────────────────────────────────────────

test('on row 1 it scrolls early so the next row is revealed', () => {
    // Row 1 top = 150; row 2 bottom = 420, past the 400px viewport.
    // Pre-fix this did nothing (the marker was nowhere near the bottom edge).
    const calls = runPlayback({ rowIdx: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].top, 150 - Math.round(VIEW_H * 0.25));   // 50
    assert.ok(420 <= calls[0].top + VIEW_H, 'next row must end up visible');
});

test('the last row centres instead of chasing a next row that does not exist', () => {
    const calls = runPlayback({ rowIdx: 3 });                      // no row 4
    assert.equal(calls.length, 1);
    assert.equal(calls[0].top, 450 - Math.round(VIEW_H / 2));      // 250
});

test('a backward seek scrolls back up to the top inset', () => {
    const calls = runPlayback({ rowIdx: 0, scrollTop: 300 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].top, 0);   // 0 - 15% inset, clamped at 0
});

test('horizontal layout never scrolls vertically', () => {
    assert.equal(runPlayback({ rowIdx: 1, isHoriz: true }).length, 0);
});

// ── study mode shares this path ──────────────────────────────────────────────

test('study mode gets the same lookahead scroll as normal playback', () => {
    for (const rowIdx of [1, 3]) {
        assert.deepEqual(
            runStudy({ rowIdx }),
            runPlayback({ rowIdx }),
            `study and playback must scroll identically on row ${rowIdx}`,
        );
    }
});

test('the lookahead is not gated on study mode', () => {
    // If a study-mode branch is ever added here, study mode silently loses the
    // lookahead again — which is exactly how it went missing the first time.
    assert.doesNotMatch(markerSrc, /_svStudyMode/);
});
