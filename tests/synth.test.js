'use strict';
/*
 * Tests for the pure WebAudioFont naming helpers backing the monitor
 * synth's instrument loading: _svWafFile/_svWafVar/_svWafUrl convert a GM
 * program number into the data-file name, the global preset variable name
 * WebAudioFont's own script defines, and the CDN URL to fetch it from.
 *
 * No DOM/window dependency — extract the real source from screen.js and
 * compile it directly. Same extraction approach as zoom.test.js.
 *
 * Run: node --test tests/synth.test.js
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

const wafBase = grab(/^const WAF_BASE\s*=.*$/m, 'WAF_BASE');
const wafSf   = grab(/^const WAF_SF\s*=.*$/m, 'WAF_SF');
const fileSrc = grab(/function _svWafFile\(gm\) \{[\s\S]*?\}/, '_svWafFile');
const varSrc  = grab(/function _svWafVar\(gm\)\s*\{[\s\S]*?\}/, '_svWafVar');
const urlSrc  = grab(/function _svWafUrl\(gm\)\s*\{[\s\S]*?\}/, '_svWafUrl');

function load() {
    return new Function(
        '"use strict";' + wafBase + '\n' + wafSf + '\n' + fileSrc + '\n' + varSrc + '\n' + urlSrc
        + '\nreturn { _svWafFile, _svWafVar, _svWafUrl };'
    )();
}
const { _svWafFile, _svWafVar, _svWafUrl } = load();

// ── _svWafFile ────────────────────────────────────────────────────────────

test('_svWafFile zero-pads GM program 0 (Grand Piano) to 4 digits', () => {
    assert.equal(_svWafFile(0), '0000_JCLive_sf2_file');
});

test('_svWafFile multiplies the GM program number by 10', () => {
    assert.equal(_svWafFile(19), '0190_JCLive_sf2_file');   // Organ
});

test('_svWafFile handles a 3-digit result without truncating', () => {
    assert.equal(_svWafFile(88), '0880_JCLive_sf2_file');   // Synth Pad
});

// ── _svWafVar / _svWafUrl ────────────────────────────────────────────────

test('_svWafVar prefixes the file name with the WebAudioFont global-var convention', () => {
    assert.equal(_svWafVar(0), '_tone_0000_JCLive_sf2_file');
});

test('_svWafUrl builds the full CDN URL from WAF_BASE + file + .js', () => {
    assert.equal(
        _svWafUrl(4),
        'https://surikov.github.io/webaudiofontdata/sound/0040_JCLive_sf2_file.js'
    );
});

test('_svWafVar and _svWafUrl agree on the same file name for a given GM program', () => {
    // The URL's script, once loaded, must define exactly the global the
    // player looks up — a mismatch here would silently break every
    // instrument load.
    const gm = 48; // Strings
    const file = _svWafFile(gm);
    assert.ok(_svWafVar(gm).endsWith(file));
    assert.ok(_svWafUrl(gm).endsWith(file + '.js'));
});
