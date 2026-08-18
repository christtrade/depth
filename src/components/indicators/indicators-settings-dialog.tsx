'use client';

import { useState, useCallback, useRef, useLayoutEffect, useEffect } from 'react';
import { cn } from '../../lib/utils';
import { X, SlidersHorizontal, Check, Palette, ChevronDown } from 'lucide-react';
import { Switch } from '../ui/switch';
import { Slider } from '../ui/slider';
import { ColorPicker as ColorPickerReact } from '../ui/color-picker';
import type { Indicator } from '../../lib/types/indicator-types';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Button } from '../ui/button';

type FieldTab = 'params' | 'style';

type BaseField = { tab?: FieldTab };

export type IndicatorSettingField = BaseField &
    (
        | { type: 'color'; key: string; label: string }
        | { type: 'toggle'; key: string; label: string; description?: string }
        | { type: 'opacity'; key: string; label: string }
        | { type: 'fontSize'; key: string; label: string }
        | {
              type: 'slider';
              key: string;
              label: string;
              min: number;
              max: number;
              step: number;
              suffix?: string;
          }
        | {
              type: 'numberInput';
              key: string;
              label: string;
              min?: number;
              max?: number;
              step?: number;
              unit?: string;
          }
        | {
              type: 'textInput';
              key: string;
              label: string;
              placeholder?: string;
              maxLength?: number;
          }
        | {
              type: 'select';
              key: string;
              label: string;
              options: { value: string; label: string }[];
          }
        | {
              type: 'buttonGroup';
              key: string;
              label: string;
              options: { value: string; label: string; icon?: React.ReactNode }[];
          }
        | {
              type: 'stepperInt';
              key: string;
              label: string;
              min?: number;
              max?: number;
              step?: number;
          }
        | {
              type: 'rangeWithSteps';
              key: string;
              label: string;
              min: number;
              max: number;
              steps: { value: number; label: string }[];
          }
        | {
              type: 'dualColor';
              keyA: string;
              labelA: string;
              keyB: string;
              labelB: string;
              label: string;
          }
        | {
              type: 'dualOpacity';
              keyA: string;
              labelA: string;
              keyB: string;
              labelB: string;
              label: string;
          }
        | { type: 'colorGradient'; keyStart: string; keyEnd: string; label: string }
        | { type: 'checkbox'; key: string; label: string; description?: string }
        | {
              type: 'toggledInput';
              toggleKey: string;
              toggleLabel: string;
              inputKey: string;
              inputLabel: string;
              min?: number;
              max?: number;
              step?: number;
              unit?: string;
          }
        | { type: 'colorWithOpacity'; colorKey: string; opacityKey: string; label: string }
        | { type: 'toggledColor'; toggleKey: string; colorKey: string; label: string }
        | {
              type: 'inlineFields';
              label: string;
              fields: Array<
                  | {
                        type: 'stepperInt';
                        key: string;
                        label: string;
                        min?: number;
                        max?: number;
                        step?: number;
                    }
                  | {
                        type: 'buttonGroup';
                        key: string;
                        options: { value: string; label: string; icon?: React.ReactNode }[];
                    }
                  | { type: 'checkbox'; key: string; label: string }
              >;
          }
        | { type: 'section'; label: string }
    );

declare module '../../lib/types/indicator-types' {
    interface Indicator {
        settingsSchema?: IndicatorSettingField[];
    }
}

const DIALOG_W = 480;
const VIEWPORT_PADDING = 12;

const PRESET_COLORS = [
    '#e0e0e0',
    '#ef4444',
    '#f97316',
    '#eab308',
    '#22c55e',
    '#3b82f6',
    '#a855f7',
    '#ec4899',
    '#26a69a',
    '#ef5350',
    '#facc15',
    '#38bdf8',
    '#84cc16',
    '#f43f5e',
    '#06b6d4',
    '#8b5cf6',
];

const tabs: { id: 'params' | 'style'; label: string; icon: React.ReactNode }[] = [
    { id: 'params', label: 'Params', icon: <SlidersHorizontal size={13} /> },
    { id: 'style', label: 'Style', icon: <Palette size={13} /> },
];

let _rememberedPos: { x: number; y: number } | null = null;

function defaultPos() {
    return {
        x: Math.round((window.innerWidth - DIALOG_W) / 2),
        y: Math.round(window.innerHeight * 0.15),
    };
}
function clampTop(y: number, h: number) {
    const maxY = window.innerHeight - h - VIEWPORT_PADDING;
    return Math.min(Math.max(VIEWPORT_PADDING, y), Math.max(VIEWPORT_PADDING, maxY));
}
function clampLeft(x: number) {
    return Math.max(VIEWPORT_PADDING, Math.min(window.innerWidth - DIALOG_W - VIEWPORT_PADDING, x));
}

interface IndicatorSettingsDialogProps {
    indicator: Indicator;
    onUpdate: (patch: Record<string, unknown>) => void;
    onClose: () => void;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    redrawDebounceMs?: number;
}


export function IndicatorSettingsDialog({
    indicator,
    onUpdate,
    onClose,
    onMouseEnter,
    onMouseLeave,
    redrawDebounceMs = 50,
}: IndicatorSettingsDialogProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const posRef = useRef<{ x: number; y: number }>(
        _rememberedPos ?? (typeof window !== 'undefined' ? defaultPos() : { x: 80, y: 80 }),
    );
    const [, forceRender] = useState(0);
    const [tab, setTab] = useState<'params' | 'style'>('params');
    const tabsRef = useRef<HTMLDivElement | null>(null);
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const tabsToIdx = (tab): number => {
        const tabs = ['params', 'style'];
        return tabs.indexOf(tab);
    };
    const activeIdx = tabsToIdx(tab);
    const activeTabEl = tabRefs.current[activeIdx];
    const [local, setLocal] = useState<Record<string, unknown>>(
        (indicator.settings as Record<string, unknown>) ?? {},
    );

    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const patch = useCallback(
        (key: string, value: unknown) => {
            setLocal((prev) => {
                const next = { ...prev, [key]: value };
                if (debounceRef.current) clearTimeout(debounceRef.current);
                debounceRef.current = setTimeout(() => onUpdate(next), redrawDebounceMs);
                return next;
            });
        },
        [onUpdate, redrawDebounceMs],
    );

    useEffect(
        () => () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        },
        [],
    );

    useLayoutEffect(() => {
        const el = dialogRef.current;
        if (!el) return;
        const clamped = clampTop(posRef.current.y, el.offsetHeight);
        if (clamped !== posRef.current.y) {
            posRef.current = { ...posRef.current, y: clamped };
            _rememberedPos = posRef.current;
            forceRender((n) => n + 1);
        }
    });

    const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        e.stopPropagation();
        const sx = e.clientX,
            sy = e.clientY;
        const ox = posRef.current.x,
            oy = posRef.current.y;
        const onMove = (ev: MouseEvent) => {
            const h = dialogRef.current?.offsetHeight ?? 0;
            posRef.current = {
                x: clampLeft(ox + ev.clientX - sx),
                y: clampTop(oy + ev.clientY - sy, h),
            };
            _rememberedPos = posRef.current;
            forceRender((n) => n + 1);
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, []);

    const handleClose = useCallback(() => {
        onMouseLeave?.();
        onClose();
    }, [onClose, onMouseLeave]);

    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (e.key === 'Escape') handleClose();
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [handleClose]);

    const schema = indicator.settingsSchema ?? [];

    const tabFields = schema.filter((f) => {
        const t = f.tab ?? 'params';
        return t === tab;
    });

    return (
        <>
            <style>{`
                @keyframes dlg-in { from{opacity:0;transform:scale(0.94)} to{opacity:1;transform:scale(1)} }
                .dlg-enter { animation: dlg-in 160ms cubic-bezier(0.16,1,0.3,1) both; transform-origin: top left; }
            `}</style>

            <div
                ref={dialogRef}
                className="dlg-enter fixed z-[200] flex flex-col rounded-xl border border-white/10 bg-[#14161b]/90 backdrop-blur-lg shadow-2xl overflow-hidden min-h-0"
                style={{
                    left: posRef.current.x,
                    top: posRef.current.y,
                    width: DIALOG_W,
                    maxHeight: `calc(100vh - ${posRef.current.y + VIEWPORT_PADDING}px)`,
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseEnter={onMouseEnter}
                onMouseLeave={onMouseLeave}
            >
                <div
                    className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-white/6 shrink-0 cursor-grab active:cursor-grabbing select-none"
                    onMouseDown={onHeaderMouseDown}
                >
                    <div className="flex-1 min-w-0">
                        <h2 className="text-sm font-semibold text-white tracking-tight">
                            {indicator.name}
                        </h2>
                        <p className="text-[11px] text-white/40 mt-0.5">Indicator settings</p>
                    </div>
                    <button
                        className="p-1.5 rounded-lg hover:bg-white/10 text-white/40 hover:text-white transition-colors shrink-0 cursor-pointer"
                        onClick={handleClose}
                    >
                        <X size={14} />
                    </button>
                </div>

                <div
                    className="flex gap-0.5 px-4 pt-2 pb-0 shrink-0 border-b border-white/6 relative"
                    ref={tabsRef}
                >
                    {tabs.map((t, i) => (
                        <button
                            key={t.id}
                            //@ts-ignore
                            ref={(el) => (tabRefs.current[i] = el)}
                            onClick={() => setTab(t.id)}
                            className={cn(
                                'flex items-center gap-1.5 px-3 py-2 text-[11px] w-[223px] font-medium rounded-t transition-colors border-b-2 -mb-px justify-center',
                                tab === t.id
                                    ? 'text-white bg-white/5'
                                    : 'text-white/40 border-transparent hover:text-white/70 hover:bg-white/5',
                            )}
                        >
                            {t.icon}
                            {t.label}
                        </button>
                    ))}
                    <div
                        className="absolute bottom-0 left-0 border-b-2 border-blue-500 transition-all duration-200"
                        style={{
                            width: activeTabEl?.clientWidth ?? 0,
                            transform: `translateX(${activeTabEl?.offsetLeft ?? 0}px)`,
                        }}
                    />
                </div>

                <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 flex flex-col gap-3">
                    {tabFields.length === 0 && (
                        <p className="text-[12px] text-white/30 text-center py-6">
                            No {tab} settings for this indicator.
                        </p>
                    )}
                    {tabFields.map((field, i) => (
                        <FieldRow key={i} field={field} local={local} patch={patch} />
                    ))}
                </div>
            </div>
        </>
    );
}

function FieldRow({
    field,
    local,
    patch,
}: {
    field: IndicatorSettingField;
    local: Record<string, unknown>;
    patch: (key: string, value: unknown) => void;
}) {
    if (field.type === 'section') {
        return (
            <div className="pt-2 pb-1">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-white/30">
                    {field.label}
                </p>
            </div>
        );
    }

    if (field.type === 'toggle') {
        const active = Boolean(local[field.key]);
        return (
            <button
                className={cn(
                    'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-colors',
                    active
                        ? 'border-blue-500/30 bg-blue-500/8 text-white'
                        : 'border-white/6 bg-white/3 text-white/50 hover:border-white/12 hover:bg-white/5 hover:text-white/70',
                )}
                onClick={() => patch(field.key, !active)}
            >
                <div>
                    <p className="text-[12px]">{field.label}</p>
                    {field.description && (
                        <p className="text-[10px] text-white/35 mt-0.5">{field.description}</p>
                    )}
                </div>
                <Switch
                    checked={active}
                    onCheckedChange={(v) => patch(field.key, v)}
                    className="data-[state=checked]:bg-blue-500"
                />
            </button>
        );
    }

    if (field.type === 'checkbox') {
        const value = Boolean(local[field.key]);
        return (
            <button
                className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors',
                    value
                        ? 'border-blue-500/30 bg-blue-500/8 text-white'
                        : 'border-white/6 bg-white/3 text-white/50 hover:border-white/12 hover:bg-white/5 hover:text-white/70',
                )}
                onClick={() => patch(field.key, !value)}
            >
                <div
                    className={cn(
                        'w-4 h-4 rounded border-[1.5px] flex items-center justify-center shrink-0 transition-colors',
                        value ? 'border-blue-500 bg-blue-500' : 'border-white/20 bg-transparent',
                    )}
                >
                    {value && <Check size={10} strokeWidth={3} className="text-white" />}
                </div>
                <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-[12px] leading-none">{field.label}</span>
                    {field.description && (
                        <span className="text-[10px] text-white/30 leading-none">
                            {field.description}
                        </span>
                    )}
                </div>
            </button>
        );
    }

    if (field.type === 'color') {
        return (
            <div className="flex flex-col gap-2">
                <Label>{field.label}</Label>
                <ColorField
                    value={String(local[field.key] ?? '#ffffff')}
                    onChange={(v) => patch(field.key, v)}
                />
            </div>
        );
    }

    if (field.type === 'dualColor') {
        return (
            <div className="flex flex-col gap-2">
                <Label>{field.label}</Label>
                <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                        <p className="text-[10px] text-white/40">{field.labelA}</p>
                        <ColorField
                            value={String(local[field.keyA] ?? '#ffffff')}
                            onChange={(v) => patch(field.keyA, v)}
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <p className="text-[10px] text-white/40">{field.labelB}</p>
                        <ColorField
                            value={String(local[field.keyB] ?? '#ffffff')}
                            onChange={(v) => patch(field.keyB, v)}
                        />
                    </div>
                </div>
            </div>
        );
    }

    if (field.type === 'colorGradient') {
        const startColor = String(local[field.keyStart] ?? '#3b82f6');
        const endColor = String(local[field.keyEnd] ?? '#8b5cf6');
        return (
            <FieldSection label={field.label}>
                <div
                    className="w-full h-6 rounded-lg mb-3 border border-white/10"
                    style={{ background: `linear-gradient(to right, ${startColor}, ${endColor})` }}
                />
                <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                        <p className="text-[10px] text-white/40">Start</p>
                        <ColorField value={startColor} onChange={(v) => patch(field.keyStart, v)} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <p className="text-[10px] text-white/40">End</p>
                        <ColorField value={endColor} onChange={(v) => patch(field.keyEnd, v)} />
                    </div>
                </div>
            </FieldSection>
        );
    }

    if (field.type === 'colorWithOpacity') {
        const cVal = String(local[field.colorKey] ?? '#e0e0e0');
        const oVal = Number(local[field.opacityKey] ?? 1);
        return (
            <FieldSection label={field.label}>
                <div className="flex gap-3 items-start">
                    <div className="flex-1 min-w-0">
                        <ColorField value={cVal} onChange={(v) => patch(field.colorKey, v)} />
                    </div>
                    <div className="flex flex-col gap-1 w-28 shrink-0 pt-0.5">
                        <p className="text-[10px] text-white/35 font-medium">
                            Opacity - {Math.round(oVal * 100)}%
                        </p>
                        <Slider
                            value={[oVal]}
                            onValueChange={([v]) => patch(field.opacityKey, v)}
                            min={0}
                            max={1}
                            step={0.01}
                        />
                        <div className="flex justify-between text-[9px] text-white/25 font-mono">
                            <span>0%</span>
                            <span>100%</span>
                        </div>
                    </div>
                </div>
            </FieldSection>
        );
    }

    if (field.type === 'toggledColor') {
        const on = Boolean(local[field.toggleKey]);
        const cVal = String(local[field.colorKey] ?? '#e0e0e0');
        return (
            <FieldSection label="">
                <div
                    className={cn(
                        'flex flex-col rounded-lg border transition-colors overflow-hidden',
                        on ? 'border-white/10 bg-white/3' : 'border-white/6 bg-white/2',
                    )}
                >
                    <div className="flex items-center gap-3 px-3 py-2.5">
                        <Switch
                            checked={on}
                            onCheckedChange={(v) => patch(field.toggleKey, v)}
                            className="data-[state=checked]:bg-blue-500"
                        />
                        <span
                            className={cn(
                                'text-[12px] flex-1',
                                on ? 'text-white' : 'text-white/40',
                            )}
                        >
                            {field.label}
                        </span>
                        {!on && (
                            <div
                                className="w-5 h-5 rounded-full border border-white/15"
                                style={{ background: cVal }}
                            />
                        )}
                    </div>
                    {on && (
                        <div className="px-3 pb-3 border-t border-white/6">
                            <div className="pt-3">
                                <ColorField
                                    value={cVal}
                                    onChange={(v) => patch(field.colorKey, v)}
                                />
                            </div>
                        </div>
                    )}
                </div>
            </FieldSection>
        );
    }

    if (field.type === 'opacity') {
        const val = Number(local[field.key] ?? 1);
        return (
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <Label>{field.label}</Label>
                    <span className="text-[11px] font-mono text-white/40">
                        {Math.round(val * 100)}%
                    </span>
                </div>
                <Slider
                    min={0}
                    max={1}
                    step={0.01}
                    value={[val]}
                    onValueChange={([v]) => patch(field.key, v)}
                />
            </div>
        );
    }

    if (field.type === 'dualOpacity') {
        const valA = Number(local[field.keyA] ?? 0.5);
        const valB = Number(local[field.keyB] ?? 0.5);
        return (
            <FieldSection label={field.label}>
                <div className="grid grid-cols-2 gap-4">
                    {(
                        [
                            { key: field.keyA, label: field.labelA, val: valA },
                            { key: field.keyB, label: field.labelB, val: valB },
                        ] as const
                    ).map(({ key, label: lbl, val }) => (
                        <div key={key} className="flex flex-col gap-2">
                            <p className="text-[10px] text-white/35 font-medium">
                                {lbl} - {Math.round(val * 100)}%
                            </p>
                            <Slider
                                value={[val]}
                                onValueChange={([v]) => patch(key, v)}
                                min={0}
                                max={1}
                                step={0.01}
                            />
                        </div>
                    ))}
                </div>
            </FieldSection>
        );
    }

    if (field.type === 'fontSize') {
        const val = Number(local[field.key] ?? 12);
        return (
            <FieldSection label={`${field.label} - ${val}px`}>
                <Slider
                    value={[val]}
                    onValueChange={([v]) => patch(field.key, Math.round(v))}
                    max={48}
                    min={8}
                    step={1}
                />
                <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                    <span>8px</span>
                    <span>28px</span>
                    <span>48px</span>
                </div>
            </FieldSection>
        );
    }

    if (field.type === 'slider') {
        const val = Number(local[field.key] ?? field.min);
        return (
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <Label>{field.label}</Label>
                    <span className="text-[11px] font-mono text-white/40">
                        {val}
                        {field.suffix ?? ''}
                    </span>
                </div>
                <Slider
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={[val]}
                    onValueChange={([v]) => patch(field.key, v)}
                />
            </div>
        );
    }

    if (field.type === 'rangeWithSteps') {
        const val = Number(local[field.key] ?? field.min);
        return (
            <FieldSection label={`${field.label} - ${val}`}>
                <Slider
                    value={[val]}
                    onValueChange={([v]) => patch(field.key, v)}
                    min={field.min}
                    max={field.max}
                    step={(field.max - field.min) / Math.max(1, field.steps.length - 1)}
                />
                <div className="flex justify-between mt-1">
                    {field.steps.map((s) => (
                        <button
                            key={s.value}
                            className={cn(
                                'text-[10px] font-mono transition-colors',
                                val === s.value
                                    ? 'text-blue-400'
                                    : 'text-white/25 hover:text-white/50',
                            )}
                            onClick={() => patch(field.key, s.value)}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
            </FieldSection>
        );
    }

    if (field.type === 'numberInput') {
        return (
            <NumberInputField
                label={field.label}
                value={Number(local[field.key] ?? field.min ?? 0)}
                min={field.min}
                max={field.max}
                step={field.step}
                unit={field.unit}
                onChange={(v) => patch(field.key, v)}
                inline
            />
        );
    }

    if (field.type === 'stepperInt') {
        const val = Number(local[field.key] ?? field.min ?? 1);
        const step = field.step ?? 1;
        const min = field.min ?? -Infinity;
        const max = field.max ?? Infinity;
        return (
            <FieldSection label={field.label}>
                <div className="flex items-center gap-2">
                    <button
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors text-base leading-none disabled:opacity-30 disabled:cursor-not-allowed"
                        onClick={() => patch(field.key, Math.max(min, val - step))}
                        disabled={val <= min}
                    >
                        −
                    </button>
                    <span className="flex-1 text-center text-[13px] font-mono text-white tabular-nums">
                        {val}
                    </span>
                    <button
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors text-base leading-none disabled:opacity-30 disabled:cursor-not-allowed"
                        onClick={() => patch(field.key, Math.min(max, val + step))}
                        disabled={val >= max}
                    >
                        +
                    </button>
                </div>
            </FieldSection>
        );
    }

    if (field.type === 'textInput') {
        return (
            <FieldSection label={field.label}>
                <input
                    type="text"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[12px] text-white focus:outline-none focus:border-blue-500/60 placeholder:text-white/20"
                    value={String(local[field.key] ?? '')}
                    placeholder={field.placeholder}
                    maxLength={field.maxLength}
                    onChange={(e) => patch(field.key, e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                />
            </FieldSection>
        );
    }

    if (field.type === 'select') {
        const val = String(local[field.key] ?? field.options[0]?.value ?? '');
        return (
            <div className="flex items-center justify-between gap-4">
                <Label>{field.label}</Label>
                <div className="relative">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant='outline' className='flex flex-row gap-1 h-8'>
                                {val}
                                <ChevronDown />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className='z-[201]'>
                            {field.options.map(o => (
                                <DropdownMenuItem onSelect={() => patch(field.key, o.value)}>
                                    {o.label}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        );
    }

    if (field.type === 'buttonGroup') {
        const val = String(local[field.key] ?? field.options[0]?.value ?? '');
        return (
            <FieldSection label={field.label}>
                <div className="flex gap-1.5 flex-wrap">
                    {field.options.map((opt) => (
                        <button
                            key={opt.value}
                            className={cn(
                                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] transition-colors',
                                val === opt.value
                                    ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                    : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                            )}
                            onClick={() => patch(field.key, opt.value)}
                        >
                            {opt.icon}
                            {opt.label}
                        </button>
                    ))}
                </div>
            </FieldSection>
        );
    }

    if (field.type === 'toggledInput') {
        const on = Boolean(local[field.toggleKey]);
        const val = Number(local[field.inputKey] ?? field.min ?? 0);
        return (
            <FieldSection label="">
                <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-white/6 bg-white/3">
                    <Switch
                        checked={on}
                        onCheckedChange={(v) => patch(field.toggleKey, v)}
                        className="data-[state=checked]:bg-blue-500"
                    />
                    <span
                        className={cn(
                            'text-[12px] flex-1',
                            on ? 'text-white' : 'text-white/40 select-none',
                        )}
                    >
                        {field.toggleLabel}
                    </span>
                    <div
                        className={cn(
                            'flex items-center gap-1.5 transition-opacity',
                            !on && 'opacity-30 pointer-events-none',
                        )}
                    >
                        <input
                            type="number"
                            className="w-16 bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[12px] font-mono text-white text-right focus:outline-none focus:border-blue-500/60"
                            value={val}
                            min={field.min}
                            max={field.max}
                            step={field.step ?? 1}
                            onChange={(e) => patch(field.inputKey, parseFloat(e.target.value) || 0)}
                            onKeyDown={(e) => e.stopPropagation()}
                            tabIndex={on ? 0 : -1}
                        />
                        {field.unit && (
                            <span className="text-[11px] text-white/35">{field.unit}</span>
                        )}
                    </div>
                </div>
            </FieldSection>
        );
    }

    if (field.type === 'inlineFields') {
        return (
            <FieldSection label={field.label}>
                <div className="flex items-center gap-2 flex-wrap">
                    {field.fields.map((f, i) => {
                        if (f.type === 'stepperInt') {
                            const val = Number(local[f.key] ?? f.min ?? 1);
                            const step = f.step ?? 1;
                            const min = f.min ?? -Infinity;
                            const max = f.max ?? Infinity;
                            return (
                                <div
                                    key={i}
                                    className="flex items-center gap-1 bg-white/4 border border-white/8 rounded-lg px-1"
                                >
                                    <button
                                        className="w-6 h-7 flex items-center justify-center text-white/50 hover:text-white transition-colors leading-none disabled:opacity-30"
                                        onClick={() => patch(f.key, Math.max(min, val - step))}
                                        disabled={val <= min}
                                    >
                                        −
                                    </button>
                                    <span className="text-[12px] font-mono text-white tabular-nums min-w-[2ch] text-center">
                                        {val}
                                    </span>
                                    <button
                                        className="w-6 h-7 flex items-center justify-center text-white/50 hover:text-white transition-colors leading-none disabled:opacity-30"
                                        onClick={() => patch(f.key, Math.min(max, val + step))}
                                        disabled={val >= max}
                                    >
                                        +
                                    </button>
                                    {f.label && (
                                        <span className="text-[10px] text-white/30 pr-1.5">
                                            {f.label}
                                        </span>
                                    )}
                                </div>
                            );
                        }
                        if (f.type === 'buttonGroup') {
                            const val = String(local[f.key] ?? f.options[0]?.value ?? '');
                            return (
                                <div key={i} className="flex gap-1">
                                    {f.options.map((opt) => (
                                        <button
                                            key={opt.value}
                                            title={opt.label}
                                            className={cn(
                                                'w-7 h-7 flex items-center justify-center rounded-lg border text-[11px] transition-colors',
                                                val === opt.value
                                                    ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                                    : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                                            )}
                                            onClick={() => patch(f.key, opt.value)}
                                        >
                                            {opt.icon ?? opt.label[0]}
                                        </button>
                                    ))}
                                </div>
                            );
                        }
                        if (f.type === 'checkbox') {
                            const val = Boolean(local[f.key]);
                            return (
                                <button
                                    key={i}
                                    className={cn(
                                        'flex items-center gap-1.5 px-2.5 h-7 rounded-lg border text-[11px] transition-colors',
                                        val
                                            ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                            : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                                    )}
                                    onClick={() => patch(f.key, !val)}
                                >
                                    {val && <Check size={10} strokeWidth={3} />}
                                    {f.label}
                                </button>
                            );
                        }
                        return null;
                    })}
                </div>
            </FieldSection>
        );
    }

    return null;
}

function NumberInputField({
    label,
    value,
    min,
    max,
    step,
    unit,
    onChange,
    inline,
}: {
    label: string;
    value: number;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    onChange: (v: number) => void;
    inline?: boolean;
}) {
    const [localVal, setLocalVal] = useState(() => String(value));
    const focused = useRef(false);

    useEffect(() => {
        if (!focused.current) setLocalVal(String(value));
    }, [value]);

    const commit = () => {
        const v = parseFloat(localVal);
        if (!isNaN(v)) {
            const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
            onChange(clamped);
            setLocalVal(String(clamped));
        } else {
            setLocalVal(String(value));
        }
    };

    const input = (
        <input
            type="number"
            min={min}
            max={max}
            step={step ?? 1}
            value={localVal}
            onChange={(e) => setLocalVal(e.target.value)}
            onFocus={() => {
                focused.current = true;
            }}
            onBlur={() => {
                focused.current = false;
                commit();
            }}
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commit();
            }}
            className={cn(
                'bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[12px] font-mono text-white/80 focus:outline-none focus:border-blue-500/50 text-right',
                inline ? 'w-20' : 'flex-1',
            )}
        />
    );

    if (inline) {
        return (
            <div className="flex items-center justify-between gap-4">
                <Label>{label}</Label>
                <div className="flex items-center gap-1.5">
                    {input}
                    {unit && <span className="text-[11px] text-white/30">{unit}</span>}
                </div>
            </div>
        );
    }

    return (
        <FieldSection label={label}>
            <div className="flex items-center gap-2">
                {input}
                {unit && <span className="text-[11px] text-white/35 shrink-0">{unit}</span>}
            </div>
        </FieldSection>
    );
}

function Label({ children }: { children: React.ReactNode }) {
    return <p className="text-[12px] text-white/70">{children}</p>;
}

function FieldSection({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            {label && (
                <p className="text-[10px] font-semibold text-white/35 uppercase tracking-widest">
                    {label}
                </p>
            )}
            {children}
        </div>
    );
}

function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-8 gap-1.5">
                {PRESET_COLORS.map((c) => (
                    <button
                        key={c}
                        className={cn(
                            'w-7 h-7 rounded-full border-2 transition-all hover:scale-110 flex items-center justify-center',
                            value === c ? 'border-white scale-110' : 'border-white/10',
                        )}
                        style={{ background: c }}
                        onClick={() => onChange(c)}
                    >
                        {value === c && (
                            <Check size={11} className="text-black drop-shadow" strokeWidth={3} />
                        )}
                    </button>
                ))}
            </div>
            <ColorPickerReact
                onChange={onChange}
                value={value}
                className="w-8 h-8 rounded-md border-2 border-border/50"
            />
        </div>
    );
}
