import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CHART_SETTINGS, diffChartSettings, themedSettings } from './chart-settings';

const gruvbox = { backgroundColor: '#282828', upBodyColor: '#b8bb26', gridHorizontalColor: '#3c3836' };

describe('themedSettings', () => {
    it('colors still at their default take the theme', () => {
        const out = themedSettings({ ...DEFAULT_CHART_SETTINGS }, gruvbox);
        assert.equal(out.backgroundColor, '#282828');
        assert.equal(out.upBodyColor, '#b8bb26');
    });

    it('a color the user picked wins over the theme', () => {
        const mine = { ...DEFAULT_CHART_SETTINGS, upBodyColor: '#ff0000' };
        const out = themedSettings(mine, gruvbox);
        assert.equal(out.upBodyColor, '#ff0000');
        assert.equal(out.backgroundColor, '#282828');
    });

    it('keys the theme leaves out keep the default', () => {
        const out = themedSettings({ ...DEFAULT_CHART_SETTINGS }, gruvbox);
        assert.equal(out.downBodyColor, DEFAULT_CHART_SETTINGS.downBodyColor);
    });

    it('hands back the same object when the theme changes nothing', () => {
        const s = { ...DEFAULT_CHART_SETTINGS };
        assert.equal(themedSettings(s, undefined), s);
        assert.equal(themedSettings(s, {}), s);
        assert.equal(themedSettings(s, { backgroundColor: DEFAULT_CHART_SETTINGS.backgroundColor }).backgroundColor, s.backgroundColor);
    });

    it("doesn't touch what gets saved - the theme's colors never end up in the diff", () => {
        const mine = { ...DEFAULT_CHART_SETTINGS, upBodyColor: '#ff0000' };
        themedSettings(mine, gruvbox);
        assert.deepEqual(diffChartSettings(mine), { upBodyColor: '#ff0000' });
    });
});
