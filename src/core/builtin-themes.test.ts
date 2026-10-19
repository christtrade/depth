import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUILTIN_THEMES } from './builtin-themes';
import { themeCss } from './theme-style';
import { CHART_COLOR_KEYS } from '../lib/types/chart-settings';

const KEYS: readonly string[] = CHART_COLOR_KEYS;
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

describe('built-in themes', () => {
    it('ids are unique and dark is the first', () => {
        const ids = BUILTIN_THEMES.map((t) => t.id);
        assert.equal(new Set(ids).size, ids.length);
        assert.equal(ids[0], 'dark');
    });

    for (const theme of BUILTIN_THEMES) {
        it(`${theme.id}: every var makes it into the css`, () => {
            const declared = (themeCss(theme)?.match(/--[a-z0-9-]+:/g) ?? []).length;
            assert.equal(declared, Object.keys(theme.vars).length);
        });

        it(`${theme.id}: chart colors are real settings, as hex`, () => {
            for (const [key, value] of Object.entries(theme.chart ?? {})) {
                assert.ok(KEYS.includes(key), `${key} isn't a chart color`);
                assert.match(String(value), HEX, `${key}: ${value}`);
            }
        });
    }
});
