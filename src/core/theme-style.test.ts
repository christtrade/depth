import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { themeCss } from './theme-style';

describe('themeCss', () => {
    it('puts the vars on .depth-root, with the color scheme', () => {
        const css = themeCss({ id: 'nord', name: 'Nord', vars: { background: '220 16% 22%', 'brand-400': '143 195 209' } });
        assert.equal(css, '.depth-root { --background: 220 16% 22%; --brand-400: 143 195 209; color-scheme: dark; }');
    });

    it('light themes get a light color scheme', () => {
        const css = themeCss({ id: 'paper', name: 'Paper', dark: false, vars: { background: '0 0% 100%' } });
        assert.match(css!, /color-scheme: light;/);
    });

    it('no vars, no rule - the host keeps control', () => {
        assert.equal(themeCss({ id: 'dark', name: 'Dark', vars: {} }), null);
    });

    it("drops names and values that could break out of the rule", () => {
        const css = themeCss({
            id: 'evil',
            name: 'Evil',
            vars: {
                background: 'red} body { display: none',
                'bad name': '1px',
                'x;y': '2px',
                card: '0 0% 10%; color: red',
                ok: '220 14% 12%',
            },
        });
        assert.equal(css, '.depth-root { --ok: 220 14% 12%; color-scheme: dark; }');
    });
});
