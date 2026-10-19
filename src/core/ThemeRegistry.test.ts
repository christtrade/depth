import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_THEME_ID, ThemeRegistry } from './ThemeRegistry';
import { PluginRegistry } from './PluginRegistry';
import { TypedEventBus } from './TypedEventBus';
import type { ThemeDef } from '../interfaces/plugins/IChartPlugin';

const nord: ThemeDef = { id: 'nord', name: 'Nord', vars: { background: '220 16% 22%' } };

function setup(initial?: string) {
    const bus = new TypedEventBus();
    const seen: string[] = [];
    bus.on('theme:change', (t) => seen.push(t.id));
    return { bus, seen, themes: new ThemeRegistry(bus, undefined, initial) };
}

describe('ThemeRegistry', () => {
    it('starts on the default, or on a known initial id', () => {
        assert.equal(setup().themes.current.id, DEFAULT_THEME_ID);
        assert.equal(setup('nope').themes.current.id, DEFAULT_THEME_ID);
    });

    it('set switches and emits once, unknown ids are refused', () => {
        const { themes, seen } = setup();
        themes.register(nord);
        assert.equal(themes.set('nord'), true);
        assert.equal(themes.set('nord'), true);
        assert.equal(themes.set('missing'), false);
        assert.deepEqual(seen, ['nord']);
        assert.equal(themes.current.id, 'nord');
    });

    it('re-registering the current theme emits it, so a hot reload repaints', () => {
        const { themes, seen } = setup();
        themes.register(nord);
        themes.set('nord');
        const edited = { ...nord, vars: { background: '0 0% 0%' } };
        themes.register(edited);
        assert.deepEqual(seen, ['nord', 'nord']);
        assert.equal(themes.current, edited);
    });

    it('unregistering the current theme falls back to the default', async () => {
        const { themes, seen } = setup();
        const off = themes.register(nord);
        themes.set('nord');
        off();
        assert.equal(themes.current.id, DEFAULT_THEME_ID);
        assert.equal(themes.get('nord'), undefined);
        await Promise.resolve();
        assert.deepEqual(seen, ['nord', DEFAULT_THEME_ID]);
    });

    it('a hot reload keeps the chart on the theme', async () => {
        const { themes, seen } = setup();
        const off = themes.register(nord);
        themes.set('nord');
        off();
        const edited = { ...nord, vars: { background: '0 0% 0%' } };
        themes.register(edited);
        await Promise.resolve();
        assert.equal(themes.current, edited);
        assert.deepEqual(seen, ['nord', 'nord']);
    });

    it("an old unregister can't remove the theme that replaced it", () => {
        const { themes } = setup();
        const offOld = themes.register(nord);
        const replacement = { ...nord, name: 'Nord 2' };
        themes.register(replacement);
        offOld();
        assert.equal(themes.get('nord'), replacement);
    });

    it('lifecycle.onThemeChange hears it, with the mode and the theme', () => {
        const { bus, themes } = setup();
        const heard: [string, string][] = [];
        new PluginRegistry().buildLifecycle(bus).onThemeChange((mode, t) => heard.push([mode, t.id]));
        themes.register({ id: 'paper', name: 'Paper', dark: false, vars: {} });
        themes.register(nord);
        themes.set('paper');
        themes.set('nord');
        assert.deepEqual(heard, [
            ['light', 'paper'],
            ['dark', 'nord'],
        ]);
    });

    it("the default can't be unregistered", () => {
        const { themes } = setup();
        const off = themes.register({ id: DEFAULT_THEME_ID, name: 'Mine', vars: {} });
        off();
        assert.ok(themes.get(DEFAULT_THEME_ID));
    });
});
