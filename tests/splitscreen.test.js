'use strict';
/*
 * Tests for the splitscreen mount helpers _ssActive() / _resolveMount().
 *
 * These decide whether staffview is running inside a splitscreen panel and,
 * if so, where its canvas mounts. The behaviour that most needs pinning down
 * (and is the one path not exercised by the manual verification on PR #5) is
 * the dual-global read:
 *
 *     const ss = window.feedBackSplitscreen || window.slopsmithSplitscreen;
 *
 * The published splitscreen plugin still exports only the pre-rename
 * `slopsmithSplitscreen`, while core's highway_3d reads `feedBackSplitscreen`
 * — so staffview reads both, PREFERRING the current name. If that preference
 * or the fallback ever regresses, splitscreen silently stops mounting.
 *
 * Both functions are browser-scoped (they touch `window` / `document`), so
 * this extracts their real source text from screen.js and compiles it inside
 * a `new Function` with `window` / `document` injected as parameters — real
 * source, no drift, no jsdom. Same extraction approach as the editor plugin's
 * feedpak_song_list.test.js.
 *
 * Run: node --test tests/splitscreen.test.js
 */
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Extract the two top-level helpers verbatim from screen.js ────────────────
// Both are column-0 `function … { … }` whose only column-0 `\n}` is their own
// close (inner braces are indented), so a non-greedy match to the first
// `\n}` captures each body exactly.
const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');

function grab(re, label) {
    const m = src.match(re);
    if (!m) throw new Error(`could not extract ${label} from screen.js`);
    return m[0];
}
const ssActiveSrc = grab(/function _ssActive\(\) \{[\s\S]*?\n\}/, '_ssActive');
const resolveMountSrc = grab(/function _resolveMount\(canvas\) \{[\s\S]*?\n\}/, '_resolveMount');

// Compile both together (…_resolveMount calls _ssActive) with the browser
// globals passed in, and return them bound to those globals.
function load(win, doc) {
    return new Function(
        'window', 'document',
        '"use strict";' + ssActiveSrc + '\n' + resolveMountSrc +
        '\nreturn { _ssActive, _resolveMount };'
    )(win, doc);
}

// ── Mock builders ────────────────────────────────────────────────────────────

// A splitscreen global. `active` drives isActive(); omit `chrome` to simulate
// a build missing panelChromeFor. `chromeReturn` is the node it hands back.
function makeSS({ active = true, chrome = true, chromeReturn } = {}) {
    const ss = { isActive: () => active };
    if (chrome) {
        ss.panelChromeFor = (canvas) => {
            ss._lastCanvas = canvas;              // record what we were handed
            return chromeReturn !== undefined ? chromeReturn : { panel: true };
        };
    }
    return ss;
}

// Minimal document whose getElementById records the id it was asked for.
function makeDoc(playerEl = { id: 'player' }) {
    return {
        _asked: [],
        getElementById(id) { this._asked.push(id); return id === 'player' ? playerEl : null; },
    };
}

// ── _ssActive ────────────────────────────────────────────────────────────────

test('_ssActive is false when neither splitscreen global is present', () => {
    const { _ssActive } = load({}, makeDoc());
    assert.equal(_ssActive(), false);
});

test('_ssActive is true for an active feedBackSplitscreen with panel chrome', () => {
    const { _ssActive } = load({ feedBackSplitscreen: makeSS({ active: true }) }, makeDoc());
    assert.equal(_ssActive(), true);
});

test('_ssActive falls back to slopsmithSplitscreen when feedBack global is absent', () => {
    const { _ssActive } = load({ slopsmithSplitscreen: makeSS({ active: true }) }, makeDoc());
    assert.equal(_ssActive(), true);
});

test('_ssActive is false when the active splitscreen lacks panelChromeFor', () => {
    // isActive() true but no chrome function — staffview can't mount, so inactive.
    const { _ssActive } = load({ feedBackSplitscreen: makeSS({ active: true, chrome: false }) }, makeDoc());
    assert.equal(_ssActive(), false);
});

test('_ssActive is false when isActive() returns false', () => {
    const { _ssActive } = load({ feedBackSplitscreen: makeSS({ active: false }) }, makeDoc());
    assert.equal(_ssActive(), false);
});

test('_ssActive is false when isActive is not a function', () => {
    const { _ssActive } = load({ feedBackSplitscreen: { panelChromeFor: () => ({}) } }, makeDoc());
    assert.equal(_ssActive(), false);
});

test('_ssActive prefers feedBackSplitscreen: an inactive feedBack global wins over an active slopsmith one', () => {
    // `feedBack || slopsmith` short-circuits on the truthy feedBack object, so
    // slopsmith is never consulted — an inactive feedBack build reads as inactive.
    const win = {
        feedBackSplitscreen: makeSS({ active: false }),
        slopsmithSplitscreen: makeSS({ active: true }),
    };
    const { _ssActive } = load(win, makeDoc());
    assert.equal(_ssActive(), false);
});

// ── _resolveMount ────────────────────────────────────────────────────────────

test('_resolveMount returns #player when not in splitscreen', () => {
    const playerEl = { id: 'player' };
    const doc = makeDoc(playerEl);
    const { _resolveMount } = load({}, doc);
    assert.equal(_resolveMount({ canvas: 1 }), playerEl);
    assert.deepEqual(doc._asked, ['player']);
});

test('_resolveMount returns the splitscreen panel chrome when active', () => {
    const panel = { panel: 'chrome-node' };
    const ss = makeSS({ active: true, chromeReturn: panel });
    const doc = makeDoc();
    const { _resolveMount } = load({ feedBackSplitscreen: ss }, doc);
    assert.equal(_resolveMount({ canvas: 1 }), panel);
    assert.deepEqual(doc._asked, [], 'must not fall back to document.getElementById when in splitscreen');
});

test('_resolveMount passes the canvas through to panelChromeFor', () => {
    const canvas = { theCanvas: true };
    const ss = makeSS({ active: true });
    const { _resolveMount } = load({ feedBackSplitscreen: ss }, makeDoc());
    _resolveMount(canvas);
    assert.equal(ss._lastCanvas, canvas);
});

test('_resolveMount uses the feedBack panel chrome, not the slopsmith one, when both are active', () => {
    const feedPanel = { which: 'feedBack' };
    const slopPanel = { which: 'slopsmith' };
    const win = {
        feedBackSplitscreen: makeSS({ active: true, chromeReturn: feedPanel }),
        slopsmithSplitscreen: makeSS({ active: true, chromeReturn: slopPanel }),
    };
    const { _resolveMount } = load(win, makeDoc());
    assert.equal(_resolveMount({}), feedPanel);
});

test('_resolveMount falls back to the slopsmith panel chrome when only the legacy global exists', () => {
    const slopPanel = { which: 'slopsmith' };
    const { _resolveMount } = load(
        { slopsmithSplitscreen: makeSS({ active: true, chromeReturn: slopPanel }) },
        makeDoc(),
    );
    assert.equal(_resolveMount({}), slopPanel);
});
