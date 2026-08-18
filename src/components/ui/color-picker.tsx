'use client';

import { forwardRef, useMemo, useState, useCallback, useEffect } from 'react';
import { HexColorPicker } from 'react-colorful';
import { cn } from '../../lib/utils';
import { useForwardedRef } from '../../lib/use-forwarded-ref';
import type { ButtonProps } from './button';
import { Button } from './button';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './popover';
import { Input } from './input';
import { Plus, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';
import { StorageKey, onChartStorageChange, readJSON, writeJSON } from '../../lib/storage';

interface ColorPickerProps {
    value: string;
    onChange: (value: string) => void;
    onBlur?: () => void;
    presets?: string[];
    hideButton?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

/** Normalise any colour string to 8-char hex (#RRGGBBAA). */
function toHex8(raw: string): string {
    const v = raw.trim();
    if (/^#[0-9a-fA-F]{8}$/.test(v)) return v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v + 'ff';
    if (/^#[0-9a-fA-F]{4}$/.test(v)) {
        const [, r, g, b, a] = v.split('');
        return `#${r}${r}${g}${g}${b}${b}${a}${a}`;
    }
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
        const [, r, g, b] = v.split('');
        return `#${r}${r}${g}${g}${b}${b}ff`;
    }
    const rgba = v.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
    if (rgba) {
        const toHex2 = (n: number) => Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0');
        const r = toHex2(parseInt(rgba[1]));
        const g = toHex2(parseInt(rgba[2]));
        const b = toHex2(parseInt(rgba[3]));
        const alpha = rgba[4] !== undefined ? parseFloat(rgba[4]) : 1;
        const a = toHex2(Math.round(alpha * 255));
        return `#${r}${g}${b}${a}`;
    }
    return '#ffffffff';
}

function hex8ToHex6(hex8: string): string {
    return hex8.slice(0, 7);
}

function hex8ToAlphaPct(hex8: string): number {
    const a = parseInt(hex8.slice(7, 9), 16);
    return Math.round((a / 255) * 100);
}

function setAlphaPct(hex8: string, pct: number): string {
    const a = Math.round((Math.min(100, Math.max(0, pct)) / 100) * 255);
    return hex8.slice(0, 7) + a.toString(16).padStart(2, '0');
}

// rgba rather than 8-char hex, which not every browser renders transparently
function hex8ToCssRgba(hex8: string): string {
    const r = parseInt(hex8.slice(1, 3), 16);
    const g = parseInt(hex8.slice(3, 5), 16);
    const b = parseInt(hex8.slice(5, 7), 16);
    const a = parseInt(hex8.slice(7, 9), 16) / 255;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

function loadSaved(): string[] {
    const saved = readJSON<unknown>(StorageKey.colorSwatches, null);
    return Array.isArray(saved) ? saved.filter((c): c is string => typeof c === 'string') : [];
}

function persistSaved(colors: string[]) {
    writeJSON(StorageKey.colorSwatches, colors);
}

const ColorPicker = forwardRef<
    HTMLInputElement,
    Omit<ButtonProps, 'value' | 'onChange' | 'onBlur'> & ColorPickerProps
>(
    (
        {
            disabled,
            value,
            onChange,
            onBlur,
            name,
            className,
            presets,
            hideButton,
            open: openProp,
            onOpenChange,
            ...props
        },
        forwardedRef,
    ) => {
        const ref = useForwardedRef(forwardedRef);
        const [internalOpen, setInternalOpen] = useState(false);

        const open = openProp !== undefined ? openProp : internalOpen;
        const setOpen = onOpenChange ?? setInternalOpen;
        const [saved, setSaved] = useState<string[]>(loadSaved);

        // pick up swatches arriving from a restored save document
        useEffect(() => onChartStorageChange(() => setSaved(loadSaved())), []);

        const hex8 = useMemo(() => toHex8(value || '#ffffffff'), [value]);
        const hex6 = hex8ToHex6(hex8);
        const alphaPct = hex8ToAlphaPct(hex8);
        const cssRgba = hex8ToCssRgba(hex8);
        const opaqueHex = hex8.slice(0, 7);

        const [inputValue, setInputValue] = useState(hex8);

        useEffect(() => {
            setInputValue(hex8);
        }, [hex8]);

        const handleColorChange = useCallback(
            (hex6: string) => {
                // merge the new hue/sat/lum with the existing alpha
                const currentAlpha = hex8.slice(7, 9);
                onChange(hex6 + currentAlpha);
            },
            [hex8, onChange],
        );

        const handleAlphaSlider = useCallback(
            (e: React.ChangeEvent<HTMLInputElement>) => {
                onChange(setAlphaPct(hex8, parseInt(e.target.value)));
            },
            [hex8, onChange],
        );

        const addToSaved = useCallback(() => {
            if (saved.includes(hex8)) return;
            const next = [...saved, hex8].slice(-16);
            setSaved(next);
            persistSaved(next);
        }, [hex8, saved]);

        const removeSaved = useCallback(
            (color: string) => {
                const next = saved.filter((c) => c !== color);
                setSaved(next);
                persistSaved(next);
            },
            [saved],
        );

        const SwatchRow = ({
            label,
            colors,
            removable,
        }: {
            label: string;
            colors: string[];
            removable?: boolean;
        }) => {
            if (!colors.length) return null;
            return (
                <div className="mt-3">
                    <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-widest">
                        {label}
                    </span>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {colors.map((c) => {
                            const css = hex8ToCssRgba(toHex8(c));
                            return (
                                <div key={c} className="relative group">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                onMouseDown={() => {
                                                    onChange(toHex8(c));
                                                }}
                                                className="w-6 h-6 px-1 rounded border border-white/10 transition-all cursor-pointer"
                                                style={{
                                                    backgroundImage: `
                                                    linear-gradient(${css}, ${css}),
                                                    repeating-conic-gradient(#888 0% 25%, #555 0% 50%)
                                                `,
                                                    backgroundSize: 'cover, 8px 8px',
                                                }}
                                            />
                                        </TooltipTrigger>
                                        <TooltipContent className="bg-background border border-border z-[400]">
                                            {c}
                                        </TooltipContent>
                                    </Tooltip>
                                    {removable && (
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                removeSaved(c);
                                            }}
                                            className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-background border border-white/20 text-muted-foreground hover:text-foreground items-center justify-center hidden group-hover:flex"
                                        >
                                            <X className="w-2 h-2" />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            );
        };

        return (
            <Popover onOpenChange={setOpen} open={open}>
                {hideButton ? (
                    // invisible anchor so PopoverContent knows where to attach
                    <PopoverAnchor asChild>
                        <span className="absolute inset-0 pointer-events-none" />
                    </PopoverAnchor>
                ) : (
                    <PopoverTrigger asChild disabled={disabled} onBlur={onBlur}>
                        <Button
                            {...props}
                            className={cn('block relative overflow-hidden', className)}
                            name={name}
                            onClick={() => setOpen(true)}
                            size="icon"
                            variant="outline"
                            style={{
                                backgroundImage: `
                            linear-gradient(${cssRgba}, ${cssRgba}),
                            repeating-conic-gradient(#888 0% 25%, #555 0% 50%)
                        `,
                                backgroundSize: 'cover, 8px 8px',
                            }}
                        >
                            <div />
                        </Button>
                    </PopoverTrigger>
                )}

                <PopoverContent className="w-full z-[300]">
                    {/* react-colorful ships no alpha slider, hence the one below */}
                    <HexColorPicker color={hex6} onChange={handleColorChange} />

                    <div className="mt-3 flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-widest">
                                Opacity
                            </span>
                            <span className="text-[11px] font-mono text-muted-foreground tabular-nums w-9 text-right">
                                {alphaPct}%
                            </span>
                        </div>

                        <div className="relative h-3 flex items-center">
                            <div
                                className="absolute inset-0 rounded-full overflow-hidden"
                                style={{
                                    backgroundImage:
                                        'repeating-conic-gradient(#888 0% 25%, #555 0% 50%)',
                                    backgroundSize: '8px 8px',
                                }}
                            />
                            <div
                                className="absolute inset-0 rounded-full"
                                style={{
                                    background: `linear-gradient(to right, transparent, ${opaqueHex})`,
                                }}
                            />
                            <input
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={alphaPct}
                                onChange={handleAlphaSlider}
                                className="relative w-full h-3 appearance-none bg-transparent cursor-pointer opacity-slider"
                            />
                        </div>
                    </div>

                    <div className="flex flex-row gap-2 mt-3">
                        <div className="!w-36">
                            <Input
                                ref={ref}
                                value={inputValue}
                                className="font-mono text-xs"
                                placeholder="#rrggbbaa"
                                maxLength={9}
                                onChange={(e) => {
                                    const val = e.currentTarget.value;
                                    setInputValue(val);

                                    // only commit a complete, valid hex
                                    if (/^#[0-9a-fA-F]{3,8}$/.test(val)) {
                                        onChange(toHex8(val));
                                    }
                                }}
                                onBlur={() => {
                                    setInputValue(hex8);
                                }}
                            />
                        </div>
                        <Tooltip delayDuration={700}>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="outline"
                                    className="hover:bg-muted"
                                    onClick={addToSaved}
                                    disabled={saved.includes(hex8)}
                                >
                                    <Plus />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent className="bg-background border border-border z-[400]">
                                Save current color
                            </TooltipContent>
                        </Tooltip>
                    </div>

                    {presets && presets.length > 0 && (
                        <SwatchRow label="Presets" colors={presets} />
                    )}

                    <SwatchRow label="Saved" colors={saved} removable />

                    <style>{`
                    .opacity-slider::-webkit-slider-thumb {
                        -webkit-appearance: none;
                        width: 14px;
                        height: 14px;
                        border-radius: 50%;
                        background: white;
                        border: 2px solid rgba(0,0,0,0.35);
                        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                        cursor: pointer;
                    }
                    .opacity-slider::-moz-range-thumb {
                        width: 14px;
                        height: 14px;
                        border-radius: 50%;
                        background: white;
                        border: 2px solid rgba(0,0,0,0.35);
                        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                        cursor: pointer;
                    }
                `}</style>
                </PopoverContent>
            </Popover>
        );
    },
);
ColorPicker.displayName = 'ColorPicker';

export { ColorPicker };
