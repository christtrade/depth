import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildParamDefaults, buildStyleSchema, type ParamDef } from './ScriptedPlugin';

// one of every variant, so a new ParamDef that nobody taught the schema builder
// about shows up here instead of as an empty Style tab
const ALL: Record<string, ParamDef> = {
    period: { label: 'Period', type: 'number', default: 20, min: 1, max: 500, unit: 'bars' },
    smoothing: { label: 'Smoothing', type: 'stepperInt', default: 3, min: 1, max: 20 },
    threshold: { label: 'Threshold', type: 'slider', default: 50, min: 0, max: 100, suffix: '%' },
    speed: {
        label: 'Speed',
        type: 'rangeWithSteps',
        default: 2,
        min: 1,
        max: 5,
        steps: [
            { value: 1, label: 'Slow' },
            { value: 5, label: 'Fast' },
        ],
    },
    alpha: { label: 'Opacity', type: 'opacity', default: 0.8 },
    labelSize: { label: 'Label size', type: 'fontSize', default: 12 },
    lineColor: { label: 'Line color', type: 'color', default: '#3b82f6' },
    prefix: { label: 'Prefix', type: 'text', default: 'MA' },
    source: { label: 'Source', type: 'select', default: 'close', options: ['open', 'close'] },
    lineStyle: {
        label: 'Line style',
        type: 'buttonGroup',
        default: 'solid',
        options: [
            { value: 'solid', label: 'Solid' },
            { value: 'dashed', label: 'Dashed' },
        ],
    },
    showLabels: { label: 'Show labels', type: 'boolean', default: true },
    extendRight: { label: 'Extend right', type: 'checkbox', default: false },
    updown: {
        label: 'Up / Down',
        type: 'dualColor',
        labelA: 'Up',
        defaultA: '#22c55e',
        labelB: 'Down',
        defaultB: '#ef4444',
    },
    opac: {
        label: 'Opacity',
        type: 'dualOpacity',
        labelA: 'Body',
        defaultA: 0.8,
        labelB: 'Wick',
        defaultB: 0.4,
    },
    grad: { label: 'Gradient', type: 'colorGradient', defaultStart: '#000', defaultEnd: '#fff' },
    fill: {
        label: 'Fill',
        type: 'colorWithOpacity',
        defaultColor: '#3b82f6',
        defaultOpacity: 0.2,
    },
    midline: {
        label: 'Mid-line',
        type: 'toggledColor',
        defaultToggle: false,
        defaultColor: '#ffffff',
    },
    offset: {
        label: 'Offset',
        type: 'toggledInput',
        toggleLabel: 'Apply',
        inputLabel: 'Bars',
        defaultToggle: false,
        defaultInput: 0,
    },
    sizing: {
        label: 'Size',
        type: 'inlineFields',
        fields: [
            { type: 'stepperInt', key: 'lineWidth', label: 'px', default: 2 },
            { type: 'checkbox', key: 'boldText', label: 'Bold', default: false },
        ],
    },
};

// every settings key a field reads or writes
function keysOf(field: Record<string, any>): string[] {
    if (field.type === 'inlineFields') return field.fields.map((f: any) => f.key);
    const out: string[] = [];
    for (const prop of [
        'key',
        'keyA',
        'keyB',
        'keyStart',
        'keyEnd',
        'colorKey',
        'opacityKey',
        'toggleKey',
        'inputKey',
    ]) {
        if (typeof field[prop] === 'string') out.push(field[prop]);
    }
    return out;
}

describe('plugin param schemas', () => {
    it('gives every declared param a field', () => {
        const fields = buildStyleSchema(ALL);
        assert.equal(fields.length, Object.keys(ALL).length);
        for (const field of fields) assert.ok(field.type, 'field has no type');
    });

    it('lines the fields up with the defaults, key for key', () => {
        const defaults = buildParamDefaults(ALL);
        const fieldKeys = buildStyleSchema(ALL).flatMap((f) => keysOf(f as any));
        assert.deepEqual(fieldKeys.slice().sort(), Object.keys(defaults).sort());
    });

    it('expands the compound types onto their suffixed keys', () => {
        const defaults = buildParamDefaults(ALL);
        assert.equal(defaults.updown_a, '#22c55e');
        assert.equal(defaults.updown_b, '#ef4444');
        assert.equal(defaults.grad_start, '#000');
        assert.equal(defaults.fill_opacity, 0.2);
        assert.equal(defaults.midline_on, false);
        assert.equal(defaults.offset_val, 0);
        // inlineFields sub-keys stay flat
        assert.equal(defaults.lineWidth, 2);
    });

    it('spells out the slider tick labels the style dialog needs', () => {
        const slider = buildStyleSchema(ALL).find((f) => f.type === 'slider') as any;
        assert.deepEqual(
            [slider.step1, slider.step2, slider.step3],
            ['0%', '50%', '100%'],
        );
    });

    it('drops the tab key, which only the indicator dialog understands', () => {
        for (const field of buildStyleSchema(ALL)) {
            assert.ok(!('tab' in field), `${field.type} still carries a tab`);
        }
    });
});
