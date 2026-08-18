'use client';

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { cn } from '../../lib/utils';
import {
    X,
    CandlestickChart,
    Ruler,
    Minus,
    LayoutDashboard,
    Globe,
    Monitor,
    RotateCcw,
    Trash2,
    Download,
    Puzzle,
} from 'lucide-react';
import { Switch } from '../ui/switch';
import { Slider } from '../ui/slider';
import { ColorPicker as ColorPickerReact } from '../ui/color-picker';
import { FootprintMode } from '../../lib/types/footprint';
import { TimezoneSelect } from './tz';
import type { ChartSettings } from '../../lib/types/chart-settings';
import { DEFAULT_CHART_SETTINGS } from '../../lib/types/chart-settings';
import type { ChartTypePlugin } from '../../interfaces/plugins/IChartTypePlugin';
import { StyleFieldControl, fieldKey } from '../drawings/drawing-settings-dialog';
import {
    chartStorageSize,
    clearChartStorage,
    isPersistenceEnabled,
    setPersistenceEnabled,
} from '../../lib/storage';
import {
    hasTradingViewSettings,
    importTradingViewSettings,
    readTradingViewChartSettings,
} from '../../lib/tradingview-import';

export type { ChartSettings } from '../../lib/types/chart-settings';
export { DEFAULT_CHART_SETTINGS } from '../../lib/types/chart-settings';


const DIALOG_W = 480;
const VIEWPORT_PADDING = 12;

const DASH_PRESETS: { label: string; dash: number[] }[] = [
    { label: 'Solid', dash: [] },
    { label: 'Dashed', dash: [6, 6] },
    { label: 'Dotted', dash: [2, 3] },
    { label: 'Dash-dot', dash: [8, 3, 2, 3] },
];


let _rememberedPos: { x: number; y: number } | null = null;

function defaultPos(): { x: number; y: number } {
    return {
        x: Math.round((window.innerWidth - DIALOG_W) / 2),
        y: Math.round(window.innerHeight * 0.1),
    };
}

function clampTop(y: number, h: number): number {
    const maxY = window.innerHeight - h - VIEWPORT_PADDING;
    return Math.min(Math.max(VIEWPORT_PADDING, y), Math.max(VIEWPORT_PADDING, maxY));
}

function clampLeft(x: number): number {
    return Math.max(VIEWPORT_PADDING, Math.min(window.innerWidth - DIALOG_W - VIEWPORT_PADDING, x));
}


type Tab = 'candles' | 'scales' | 'lines' | 'status' | 'chart' | 'timezone' | 'plugin';

interface ChartSettingsDialogProps {
    settings: ChartSettings;
    horizon: bigint;
    onUpdate: (patch: Partial<ChartSettings>) => void;
    onClose: () => void;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    /** The active chart type, when it came from a plugin. Adds its own tab. */
    pluginChartType?: ChartTypePlugin | null;
}


export function ChartSettingsDialog({
    settings,
    horizon,
    onUpdate,
    onClose,
    onMouseEnter,
    onMouseLeave,
    pluginChartType,
}: ChartSettingsDialogProps) {
    const [pickedTab, setTab] = useState<Tab>('candles');
    // the plugin tab can vanish under the user if they switch chart type with
    // the dialog open
    const pluginSchema = pluginChartType?.settingsSchema ?? [];
    const tab: Tab = pickedTab === 'plugin' && !pluginSchema.length ? 'candles' : pickedTab;
    const tabsRef = useRef<HTMLDivElement | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const s = settings;

    const [tzSelectOpen, setTzSelectOpen] = useState(false);

    const posRef = useRef<{ x: number; y: number }>(
        _rememberedPos ?? (typeof window !== 'undefined' ? defaultPos() : { x: 80, y: 80 }),
    );
    const [, forceRender] = useState(0);

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

    // the active plugin chart type gets a tab of its own, named after it, and
    // only while it has something to show
    const pluginId = pluginChartType?.chartTypeId ?? '';
    // a host can hand us its own settings object, and one made before this
    // field existed wont have it
    const allPluginSettings = s.pluginSettings ?? {};
    const pluginValues: Record<string, unknown> = {
        ...(pluginChartType?.defaultSettings ?? {}),
        ...(allPluginSettings[pluginId] ?? {}),
    };
    const updatePluginSetting = (patch: Record<string, unknown>) => {
        const next = { ...pluginValues, ...patch };
        onUpdate({ pluginSettings: { ...allPluginSettings, [pluginId]: next } });
    };

    const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
        { id: 'candles', label: 'Candles', icon: <CandlestickChart size={14} /> },
        { id: 'scales', label: 'Scales', icon: <Ruler size={14} /> },
        { id: 'lines', label: 'Lines', icon: <Minus size={14} /> },
        { id: 'status', label: 'Status', icon: <LayoutDashboard size={14} /> },
        { id: 'chart', label: 'Chart', icon: <Monitor size={14} /> },
        { id: 'timezone', label: 'Timezone', icon: <Globe size={14} /> },
        ...(pluginSchema.length
            ? [
                  {
                      id: 'plugin' as Tab,
                      label: pluginChartType!.label,
                      icon: <Puzzle size={14} />,
                  },
              ]
            : []),
    ];
    const tabToIdx = (id: Tab): number => Math.max(0, tabs.findIndex((t) => t.id === id));

    return (
        <>
            <style>{`
                @keyframes dlg-in { from{opacity:0;transform:scale(0.94)} to{opacity:1;transform:scale(1)} }
                .dlg-enter { animation: dlg-in 160ms cubic-bezier(0.16,1,0.3,1) both; transform-origin: top left; }
            `}</style>

            <div
                ref={dialogRef}
                className="dlg-enter fixed z-[200] flex flex-col bg-[#14161b]/90 backdrop-blur-lg rounded-xl border border-white/10 bg-[#14161b] shadow-2xl overflow-hidden min-h-0"
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
                            Chart Settings
                        </h2>
                        <p className="text-[11px] text-white/40 mt-0.5">
                            Appearance & behaviour
                        </p>
                    </div>
                    <button
                        className="p-1.5 rounded-lg hover:bg-white/10 text-white/40 hover:text-white transition-all shrink-0 cursor-pointer active:scale-95"
                        onClick={handleClose}
                    >
                        <X size={18} />
                    </button>
                </div>

                <div
                    className="grid shrink-0 border-b border-white/6 relative"
                    style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}
                    ref={tabsRef}
                >
                    {tabs.map((t) => (
                        <button
                            key={t.id}
                            onMouseDown={() => setTab(t.id)}
                            className={cn(
                                'flex flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-medium transition-colors border-b-2 -mb-px',
                                tab === t.id
                                    ? 'text-white bg-white/5'
                                    : 'text-white/35 border-transparent hover:text-white/65 hover:bg-white/4',
                            )}
                        >
                            {t.icon}
                            <span>{t.label}</span>
                        </button>
                    ))}
                    <div
                        className="absolute bottom-0 left-0 border-b-2 border-blue-500 transition-transform duration-200"
                        style={{
                            width: `${100 / tabs.length}%`,
                            transform: `translateX(${
                                tabToIdx(tab) *
                                (tabsRef.current ? tabsRef.current.clientWidth / tabs.length : 0)
                            }px)`,
                        }}
                    />
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
                    {tab === 'candles' && (
                        <div className="flex flex-col gap-5">
                            <Section label="Body colors">
                                <div className="grid grid-cols-2 gap-3">
                                    <ColorRow
                                        label="Bullish"
                                        value={s.upBodyColor}
                                        onChange={(v) => onUpdate({ upBodyColor: v })}
                                    />
                                    <ColorRow
                                        label="Bearish"
                                        value={s.downBodyColor}
                                        onChange={(v) => onUpdate({ downBodyColor: v })}
                                    />
                                </div>
                            </Section>

                            <Section label="Wick colors">
                                <InlineToggleRow
                                    label="Match body color"
                                    active={s.wickColorMatchesBody}
                                    onToggle={() =>
                                        onUpdate({
                                            wickColorMatchesBody: !s.wickColorMatchesBody,
                                        })
                                    }
                                />
                                {!s.wickColorMatchesBody && (
                                    <div className="grid grid-cols-2 gap-3 mt-3">
                                        <ColorRow
                                            label="Bullish wick"
                                            value={s.upWickColor}
                                            onChange={(v) => onUpdate({ upWickColor: v })}
                                        />
                                        <ColorRow
                                            label="Bearish wick"
                                            value={s.downWickColor}
                                            onChange={(v) => onUpdate({ downWickColor: v })}
                                        />
                                    </div>
                                )}
                            </Section>

                            <Section label={`Wick width - ${s.wickWidth}px`}>
                                <Slider
                                    value={[s.wickWidth]}
                                    onValueChange={([v]) => onUpdate({ wickWidth: v })}
                                    min={1}
                                    max={4}
                                    step={1}
                                    className="w-full"
                                />
                                <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                    {[1, 2, 3, 4].map((v) => (
                                        <span key={v}>{v}px</span>
                                    ))}
                                </div>
                            </Section>

                            <Section label="Border colors">
                                <InlineToggleRow
                                    label="Match body color"
                                    active={s.borderColorMatchesBody}
                                    onToggle={() =>
                                        onUpdate({
                                            borderColorMatchesBody: !s.borderColorMatchesBody,
                                        })
                                    }
                                />
                                {!s.borderColorMatchesBody && (
                                    <div className="grid grid-cols-2 gap-3 mt-3">
                                        <ColorRow
                                            label="Bullish border"
                                            value={s.upBorderColor}
                                            onChange={(v) => onUpdate({ upBorderColor: v })}
                                        />
                                        <ColorRow
                                            label="Bearish border"
                                            value={s.downBorderColor}
                                            onChange={(v) => onUpdate({ downBorderColor: v })}
                                        />
                                    </div>
                                )}
                            </Section>

                            <Section label={`Border width - ${s.borderWidth}px`}>
                                <Slider
                                    value={[s.borderWidth]}
                                    onValueChange={([v]) => onUpdate({ borderWidth: v })}
                                    min={0}
                                    max={4}
                                    step={1}
                                    className="w-full"
                                />
                                <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                    {[0, 1, 2, 3, 4].map((v) => (
                                        <span key={v}>{v}px</span>
                                    ))}
                                </div>
                            </Section>

                            {s.chartType === 'footprint' && (
                                <>
                                    <Section label="Footprint display mode">
                                        <div className="flex gap-1.5 flex-wrap">
                                            {(
                                                ['bid-ask', 'profile', 'delta', 'total'] as FootprintMode[]
                                            ).map((m) => (
                                                <ToggleChip
                                                    key={m}
                                                    active={s.footprintMode === m}
                                                    onClick={() => onUpdate({ footprintMode: m })}
                                                >
                                                    {m === 'bid-ask'
                                                        ? 'Bid/Ask'
                                                        : m.charAt(0).toUpperCase() + m.slice(1)}
                                                </ToggleChip>
                                            ))}
                                        </div>
                                    </Section>

                                    {s.footprintMode === 'bid-ask' && (
                                        <Section label="Volume display">
                                            <div className="flex gap-1.5">
                                                {(['none', 'split', 'total'] as const).map((v) => (
                                                    <ToggleChip
                                                        key={v}
                                                        active={s.footprintVolume === v}
                                                        onClick={() => onUpdate({ footprintVolume: v })}
                                                    >
                                                        {v === 'none'
                                                            ? 'None'
                                                            : v === 'split'
                                                              ? 'Split'
                                                              : 'Total'}
                                                    </ToggleChip>
                                                ))}
                                            </div>
                                            <p className="text-[10px] text-white/25 mt-1.5">
                                                {s.footprintVolume === 'none' &&
                                                    'No volume bar - bid/ask numbers only'}
                                                {s.footprintVolume === 'split' &&
                                                    'Separate bid and ask volume bars'}
                                                {s.footprintVolume === 'total' &&
                                                    'Single combined volume bar'}
                                            </p>
                                        </Section>
                                    )}

                                    <Section label="Footprint signals">
                                        <div className="flex flex-col gap-2">
                                            <InlineToggleRow
                                                label="Stacked imbalance"
                                                active={s.footprintShowStackedImbalance}
                                                onToggle={() =>
                                                    onUpdate({
                                                        footprintShowStackedImbalance:
                                                            !s.footprintShowStackedImbalance,
                                                    })
                                                }
                                            />
                                            <InlineToggleRow
                                                label="Absorption"
                                                active={s.footprintShowAbsorption}
                                                onToggle={() =>
                                                    onUpdate({
                                                        footprintShowAbsorption: !s.footprintShowAbsorption,
                                                    })
                                                }
                                            />
                                            <InlineToggleRow
                                                label="Unfinished auction"
                                                active={s.footprintShowUnfinishedAuction}
                                                onToggle={() =>
                                                    onUpdate({
                                                        footprintShowUnfinishedAuction:
                                                            !s.footprintShowUnfinishedAuction,
                                                    })
                                                }
                                            />
                                            <InlineToggleRow
                                                label="Diagonal imbalance"
                                                active={s.footprintShowDiagonalImbalance}
                                                onToggle={() =>
                                                    onUpdate({
                                                        footprintShowDiagonalImbalance:
                                                            !s.footprintShowDiagonalImbalance,
                                                    })
                                                }
                                            />
                                        </div>
                                    </Section>

                                    <Section
                                        label={`Imbalance ratio - ${s.footprintImbalanceRatio.toFixed(1)}×`}
                                    >
                                        <Slider
                                            value={[s.footprintImbalanceRatio]}
                                            onValueChange={([v]) =>
                                                onUpdate({ footprintImbalanceRatio: v })
                                            }
                                            min={1.5}
                                            max={6}
                                            step={0.5}
                                            className="w-full"
                                        />
                                        <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                            {[1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6].map((v) => (
                                                <span key={v}>{v}×</span>
                                            ))}
                                        </div>
                                        <p className="text-[10px] text-white/25 mt-1">
                                            Ask/bid ratio required to flag a level as imbalanced
                                        </p>
                                    </Section>

                                    {s.footprintShowStackedImbalance && (
                                        <Section
                                            label={`Stacked imbalance - min ${s.footprintStackMinCount} levels`}
                                        >
                                            <Slider
                                                value={[s.footprintStackMinCount]}
                                                onValueChange={([v]) =>
                                                    onUpdate({ footprintStackMinCount: v })
                                                }
                                                min={2}
                                                max={6}
                                                step={1}
                                                className="w-full"
                                            />
                                            <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                                {[2, 3, 4, 5, 6].map((v) => (
                                                    <span key={v}>{v}</span>
                                                ))}
                                            </div>
                                            <p className="text-[10px] text-white/25 mt-1">
                                                Consecutive imbalanced levels to trigger a stacked zone
                                            </p>
                                        </Section>
                                    )}

                                    {s.footprintShowDiagonalImbalance && (
                                        <Section
                                            label={`Diagonal ratio - ${s.footprintDiagRatio.toFixed(1)}×`}
                                        >
                                            <Slider
                                                value={[s.footprintDiagRatio]}
                                                onValueChange={([v]) => onUpdate({ footprintDiagRatio: v })}
                                                min={1.5}
                                                max={6}
                                                step={0.5}
                                                className="w-full"
                                            />
                                            <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                                {[1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6].map((v) => (
                                                    <span key={v}>{v}×</span>
                                                ))}
                                            </div>
                                            <p className="text-[10px] text-white/25 mt-1">
                                                ask[n] / bid[n−1] threshold for diagonal imbalance
                                            </p>
                                        </Section>
                                    )}

                                    {s.footprintShowAbsorption && (
                                        <Section
                                            label={`Absorption threshold - ${s.footprintAbsorptionMult.toFixed(1)}× avg`}
                                        >
                                            <Slider
                                                value={[s.footprintAbsorptionMult]}
                                                onValueChange={([v]) =>
                                                    onUpdate({ footprintAbsorptionMult: v })
                                                }
                                                min={1.5}
                                                max={5}
                                                step={0.5}
                                                className="w-full"
                                            />
                                            <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                                {[1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((v) => (
                                                    <span key={v}>{v}×</span>
                                                ))}
                                            </div>
                                            <div className="mt-3">
                                                <p className="text-[11px] text-white/40 mb-2">
                                                    Max delta fraction -{' '}
                                                    {Math.round(s.footprintAbsorptionDeltaFrac * 100)}%
                                                </p>
                                                <Slider
                                                    value={[s.footprintAbsorptionDeltaFrac]}
                                                    onValueChange={([v]) =>
                                                        onUpdate({ footprintAbsorptionDeltaFrac: v })
                                                    }
                                                    min={0.05}
                                                    max={0.5}
                                                    step={0.05}
                                                    className="w-full"
                                                />
                                                <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                                    {[5, 10, 20, 30, 40, 50].map((v) => (
                                                        <span key={v}>{v}%</span>
                                                    ))}
                                                </div>
                                                <p className="text-[10px] text-white/25 mt-1">
                                                    Max |delta/total| allowed - lower = more symmetric fills
                                                    only
                                                </p>
                                            </div>
                                        </Section>
                                    )}

                                    <ResetRow
                                        onReset={() =>
                                            onUpdate({
                                                footprintImbalanceRatio:
                                                    DEFAULT_CHART_SETTINGS.footprintImbalanceRatio,
                                                footprintStackMinCount:
                                                    DEFAULT_CHART_SETTINGS.footprintStackMinCount,
                                                footprintShowStackedImbalance:
                                                    DEFAULT_CHART_SETTINGS.footprintShowStackedImbalance,
                                                footprintShowAbsorption:
                                                    DEFAULT_CHART_SETTINGS.footprintShowAbsorption,
                                                footprintShowUnfinishedAuction:
                                                    DEFAULT_CHART_SETTINGS.footprintShowUnfinishedAuction,
                                                footprintShowDiagonalImbalance:
                                                    DEFAULT_CHART_SETTINGS.footprintShowDiagonalImbalance,
                                                footprintDiagRatio:
                                                    DEFAULT_CHART_SETTINGS.footprintDiagRatio,
                                                footprintAbsorptionMult:
                                                    DEFAULT_CHART_SETTINGS.footprintAbsorptionMult,
                                                footprintAbsorptionDeltaFrac:
                                                    DEFAULT_CHART_SETTINGS.footprintAbsorptionDeltaFrac,
                                            })
                                        }
                                    />
                                </>
                            )}
                            <div className="border-t border-white/6 my-1" />

                            <ResetRow
                                onReset={() =>
                                    onUpdate({
                                        chartType: DEFAULT_CHART_SETTINGS.chartType,
                                        upBodyColor: DEFAULT_CHART_SETTINGS.upBodyColor,
                                        downBodyColor: DEFAULT_CHART_SETTINGS.downBodyColor,
                                        upWickColor: DEFAULT_CHART_SETTINGS.upWickColor,
                                        downWickColor: DEFAULT_CHART_SETTINGS.downWickColor,
                                        upBorderColor: DEFAULT_CHART_SETTINGS.upBorderColor,
                                        downBorderColor: DEFAULT_CHART_SETTINGS.downBorderColor,
                                        wickColorMatchesBody:
                                            DEFAULT_CHART_SETTINGS.wickColorMatchesBody,
                                        borderColorMatchesBody:
                                            DEFAULT_CHART_SETTINGS.borderColorMatchesBody,
                                        wickWidth: DEFAULT_CHART_SETTINGS.wickWidth,
                                        borderWidth: DEFAULT_CHART_SETTINGS.borderWidth,
                                        footprintMode: DEFAULT_CHART_SETTINGS.footprintMode,
                                        footprintVolume: DEFAULT_CHART_SETTINGS.footprintVolume,
                                        footprintImbalanceRatio:
                                            DEFAULT_CHART_SETTINGS.footprintImbalanceRatio,
                                        footprintStackMinCount:
                                            DEFAULT_CHART_SETTINGS.footprintStackMinCount,
                                        footprintShowStackedImbalance:
                                            DEFAULT_CHART_SETTINGS.footprintShowStackedImbalance,
                                        footprintShowAbsorption:
                                            DEFAULT_CHART_SETTINGS.footprintShowAbsorption,
                                        footprintShowUnfinishedAuction:
                                            DEFAULT_CHART_SETTINGS.footprintShowUnfinishedAuction,
                                        footprintShowDiagonalImbalance:
                                            DEFAULT_CHART_SETTINGS.footprintShowDiagonalImbalance,
                                        footprintDiagRatio:
                                            DEFAULT_CHART_SETTINGS.footprintDiagRatio,
                                        footprintAbsorptionMult:
                                            DEFAULT_CHART_SETTINGS.footprintAbsorptionMult,
                                        footprintAbsorptionDeltaFrac:
                                            DEFAULT_CHART_SETTINGS.footprintAbsorptionDeltaFrac,
                                    })
                                }
                            />
                        </div>
                    )}

                    {tab === 'scales' && (
                        <div className="flex flex-col gap-5">
                            <Section label="Price scale mode">
                                <div className="flex gap-1.5">
                                    {(['normal', 'percent'] as const).map((m) => (
                                        <ToggleChip
                                            key={m}
                                            active={s.priceScaleMode === m}
                                            onClick={() => onUpdate({ priceScaleMode: m })}
                                        >
                                            {m === 'normal' ? 'Linear' : '%'}
                                        </ToggleChip>
                                    ))}
                                </div>
                            </Section>

                            <Section
                                label={`Price Scale Resize Sensitivity - ${s.priceAxisResizeSensitivity}x`}
                            >
                                <Slider
                                    value={[s.priceAxisResizeSensitivity]}
                                    onValueChange={([v]) =>
                                        onUpdate({ priceAxisResizeSensitivity: v })
                                    }
                                    min={0}
                                    max={2}
                                    step={0.1}
                                    className="w-full"
                                />
                                <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                    <span>0x</span>
                                    <span>1x</span>
                                    <span>2x</span>
                                </div>
                            </Section>

                            <Section label="Options">
                                <div className="flex flex-col gap-2">
                                    <InlineToggleRow
                                        label="Auto-scale"
                                        active={s.autoScale}
                                        onToggle={() => onUpdate({ autoScale: !s.autoScale })}
                                    />
                                    <InlineToggleRow
                                        label="Invert scale"
                                        active={s.invertScale}
                                        onToggle={() => onUpdate({ invertScale: !s.invertScale })}
                                    />
                                    <InlineToggleRow
                                        label="Allow label overlap"
                                        active={s.allowLabelOverlap}
                                        onToggle={() =>
                                            onUpdate({ allowLabelOverlap: !s.allowLabelOverlap })
                                        }
                                    />
                                    <InlineToggleRow
                                        label="Animate price updates"
                                        active={s.animatePriceUpdates}
                                        onToggle={() =>
                                            onUpdate({
                                                animatePriceUpdates: !s.animatePriceUpdates,
                                            })
                                        }
                                    />
                                </div>
                            </Section>

                            <Section label={`Top margin - ${Math.round(s.scaleMarginTop * 100)}%`}>
                                <Slider
                                    value={[s.scaleMarginTop]}
                                    onValueChange={([v]) => onUpdate({ scaleMarginTop: v })}
                                    min={0}
                                    max={0.5}
                                    step={0.01}
                                    className="w-full"
                                />
                                <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                    <span>0%</span>
                                    <span>25%</span>
                                    <span>50%</span>
                                </div>
                            </Section>

                            <Section
                                label={`Bottom margin - ${Math.round(s.scaleMarginBottom * 100)}%`}
                            >
                                <Slider
                                    value={[s.scaleMarginBottom]}
                                    onValueChange={([v]) => onUpdate({ scaleMarginBottom: v })}
                                    min={0}
                                    max={0.5}
                                    step={0.01}
                                    className="w-full"
                                />
                                <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                    <span>0%</span>
                                    <span>25%</span>
                                    <span>50%</span>
                                </div>
                            </Section>

                            <ResetRow
                                onReset={() =>
                                    onUpdate({
                                        priceScaleMode: DEFAULT_CHART_SETTINGS.priceScaleMode,
                                        autoScale: DEFAULT_CHART_SETTINGS.autoScale,
                                        priceAxisResizeSensitivity:
                                            DEFAULT_CHART_SETTINGS.priceAxisResizeSensitivity,
                                        invertScale: DEFAULT_CHART_SETTINGS.invertScale,
                                        scaleMarginTop: DEFAULT_CHART_SETTINGS.scaleMarginTop,
                                        scaleMarginBottom: DEFAULT_CHART_SETTINGS.scaleMarginBottom,
                                        allowLabelOverlap: DEFAULT_CHART_SETTINGS.allowLabelOverlap,
                                    })
                                }
                            />
                        </div>
                    )}

                    {tab === 'lines' && (
                        <div className="flex flex-col gap-5">
                            <Section label="Grid">
                                <InlineToggleRow
                                    label="Show grid"
                                    active={s.showGrid}
                                    onToggle={() => onUpdate({ showGrid: !s.showGrid })}
                                />
                                {s.showGrid && (
                                    <div className="mt-3 flex flex-col gap-3">
                                        <div className="grid grid-cols-2 gap-3">
                                            <ColorRow
                                                label="Horizontal"
                                                value={s.gridHorizontalColor}
                                                onChange={(v) =>
                                                    onUpdate({ gridHorizontalColor: v })
                                                }
                                            />
                                            <ColorRow
                                                label="Vertical"
                                                value={s.gridVerticalColor}
                                                onChange={(v) => onUpdate({ gridVerticalColor: v })}
                                            />
                                        </div>
                                    </div>
                                )}
                            </Section>

                            <Section label="Crosshair">
                                <div className="flex gap-1.5 mb-3">
                                    {(['normal', 'hidden'] as const).map((m) => (
                                        <ToggleChip
                                            key={m}
                                            active={s.crosshairMode === m}
                                            onClick={() => onUpdate({ crosshairMode: m })}
                                        >
                                            {m.charAt(0).toUpperCase() + m.slice(1)}
                                        </ToggleChip>
                                    ))}
                                </div>

                                {s.crosshairMode !== 'hidden' && (
                                    <div className="flex flex-col gap-3">
                                        <ColorRow
                                            label="Crosshair color"
                                            value={s.crosshairColor}
                                            onChange={(v) => onUpdate({ crosshairColor: v })}
                                        />

                                        <div>
                                            <label className="block text-[11px] text-white/40 mb-1">
                                                Line width - {s.crosshairWidth}px
                                            </label>
                                            <Slider
                                                value={[s.crosshairWidth]}
                                                onValueChange={([v]) =>
                                                    onUpdate({ crosshairWidth: v })
                                                }
                                                min={1}
                                                max={3}
                                                step={1}
                                                className="w-full"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-[11px] text-white/40 mb-2">
                                                Line style
                                            </label>
                                            <div className="flex gap-1.5 flex-wrap">
                                                {DASH_PRESETS.map((p) => (
                                                    <ToggleChip
                                                        key={p.label}
                                                        active={
                                                            JSON.stringify(s.crosshairDash) ===
                                                            JSON.stringify(p.dash)
                                                        }
                                                        onClick={() =>
                                                            onUpdate({ crosshairDash: p.dash })
                                                        }
                                                    >
                                                        {p.label}
                                                    </ToggleChip>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </Section>

                            <Section label="Breaks">
                                <div className="flex gap-1.5 mb-3">
                                    <InlineToggleRow
                                        label="Show breaks"
                                        active={s.showBreaks}
                                        onToggle={() => onUpdate({ showBreaks: !s.showBreaks })}
                                    />
                                </div>

                                {s.showBreaks && (
                                    <div className="flex flex-col gap-3">
                                        <ColorRow
                                            label="Breaks color"
                                            value={s.breaksColor}
                                            onChange={(v) => onUpdate({ breaksColor: v })}
                                        />

                                        <div>
                                            <label className="block text-[11px] text-white/40 mb-1">
                                                Line width - {s.breaksWidth}px
                                            </label>
                                            <Slider
                                                value={[s.breaksWidth]}
                                                onValueChange={([v]) =>
                                                    onUpdate({ breaksWidth: v })
                                                }
                                                min={1}
                                                max={3}
                                                step={1}
                                                className="w-full"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-[11px] text-white/40 mb-2">
                                                Line style
                                            </label>
                                            <div className="flex gap-1.5 flex-wrap">
                                                {DASH_PRESETS.map((p) => (
                                                    <ToggleChip
                                                        key={p.label}
                                                        active={
                                                            JSON.stringify(s.breaksDash) ===
                                                            JSON.stringify(p.dash)
                                                        }
                                                        onClick={() =>
                                                            onUpdate({ breaksDash: p.dash })
                                                        }
                                                    >
                                                        {p.label}
                                                    </ToggleChip>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </Section>

                            <ResetRow
                                onReset={() =>
                                    onUpdate({
                                        showGrid: DEFAULT_CHART_SETTINGS.showGrid,
                                        gridHorizontalColor:
                                            DEFAULT_CHART_SETTINGS.gridHorizontalColor,
                                        gridVerticalColor: DEFAULT_CHART_SETTINGS.gridVerticalColor,
                                        crosshairMode: DEFAULT_CHART_SETTINGS.crosshairMode,
                                        crosshairColor: DEFAULT_CHART_SETTINGS.crosshairColor,
                                        crosshairWidth: DEFAULT_CHART_SETTINGS.crosshairWidth,
                                        crosshairDash: DEFAULT_CHART_SETTINGS.crosshairDash,
                                        showBreaks: DEFAULT_CHART_SETTINGS.showBreaks,
                                        breaksColor: DEFAULT_CHART_SETTINGS.breaksColor,
                                        breaksDash: DEFAULT_CHART_SETTINGS.breaksDash,
                                        breaksWidth: DEFAULT_CHART_SETTINGS.breaksWidth,
                                    })
                                }
                            />
                        </div>
                    )}

                    {tab === 'status' && (
                        <div className="flex flex-col gap-4">
                            <InlineToggleRow
                                label="Show status line"
                                active={s.showStatusLine}
                                onToggle={() => onUpdate({ showStatusLine: !s.showStatusLine })}
                            />

                            {s.showStatusLine && (
                                <>
                                    <Section label="Values displayed">
                                        <div className="flex flex-col gap-2">
                                            {(
                                                [
                                                    ['statusLineOHLC', 'O / H / L / C prices'],
                                                    ['statusLineVolume', 'Volume'],
                                                    [
                                                        'statusLineDelta',
                                                        'Delta (ask vol − bid vol)',
                                                    ],
                                                    ['statusLineChange', 'Change & change %'],
                                                ] as [keyof ChartSettings, string][]
                                            ).map(([key, label]) => (
                                                <InlineToggleRow
                                                    key={key}
                                                    label={label}
                                                    active={s[key] as boolean}
                                                    onToggle={() => onUpdate({ [key]: !s[key] })}
                                                />
                                            ))}
                                        </div>
                                    </Section>

                                    <Section label={`Font size - ${s.statusLineFontSize}px`}>
                                        <Slider
                                            value={[s.statusLineFontSize]}
                                            onValueChange={([v]) =>
                                                onUpdate({ statusLineFontSize: v })
                                            }
                                            min={9}
                                            max={14}
                                            step={1}
                                            className="w-full"
                                        />
                                        <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                            {[9, 10, 11, 12, 13, 14].map((v) => (
                                                <span key={v}>{v}</span>
                                            ))}
                                        </div>
                                    </Section>
                                </>
                            )}

                            <ResetRow
                                onReset={() =>
                                    onUpdate({
                                        showStatusLine: DEFAULT_CHART_SETTINGS.showStatusLine,
                                        statusLineOHLC: DEFAULT_CHART_SETTINGS.statusLineOHLC,
                                        statusLineVolume: DEFAULT_CHART_SETTINGS.statusLineVolume,
                                        statusLineDelta: DEFAULT_CHART_SETTINGS.statusLineDelta,
                                        statusLineChange: DEFAULT_CHART_SETTINGS.statusLineChange,
                                        statusLineFontSize:
                                            DEFAULT_CHART_SETTINGS.statusLineFontSize,
                                    })
                                }
                            />
                        </div>
                    )}

                    {tab === 'chart' && (
                        <div className="flex flex-col gap-5">
                            <Section label="Colors">
                                <div className="flex flex-col gap-2">
                                    <ColorRow
                                        label="Chart background"
                                        value={s.backgroundColor}
                                        onChange={(v) => onUpdate({ backgroundColor: v })}
                                    />
                                    <ColorRow
                                        label="Axis background"
                                        value={s.axisBackgroundColor}
                                        onChange={(v) => onUpdate({ axisBackgroundColor: v })}
                                    />
                                    <ColorRow
                                        label="Price line"
                                        value={s.priceLineColor}
                                        onChange={(v) => onUpdate({ priceLineColor: v })}
                                    />
                                </div>
                            </Section>

                            <Section label="Overlays">
                                <div className="flex flex-col gap-2">
                                    <InlineToggleRow
                                        label="Show bid line"
                                        active={s.showBidLine}
                                        onToggle={() => onUpdate({ showBidLine: !s.showBidLine })}
                                    />
                                    <InlineToggleRow
                                        label="Show ask line"
                                        active={s.showAskLine}
                                        onToggle={() => onUpdate({ showAskLine: !s.showAskLine })}
                                    />
                                    <InlineToggleRow
                                        label="Show mid line"
                                        active={s.showMidLine}
                                        onToggle={() => onUpdate({ showMidLine: !s.showMidLine })}
                                    />
                                    <InlineToggleRow
                                        label="Show last trade line"
                                        active={s.showLastTradeLine}
                                        onToggle={() =>
                                            onUpdate({ showLastTradeLine: !s.showLastTradeLine })
                                        }
                                    />
                                    <InlineToggleRow
                                        label="Show price line"
                                        active={s.priceLineVisible}
                                        onToggle={() =>
                                            onUpdate({ priceLineVisible: !s.priceLineVisible })
                                        }
                                    />
                                    <InlineToggleRow
                                        label="Show fills"
                                        active={s.showFills}
                                        onToggle={() => onUpdate({ showFills: !s.showFills })}
                                    />
                                </div>
                            </Section>

                            <Section label="Trade dots">
                                <InlineToggleRow
                                    label="Show trade dots"
                                    active={s.showTradeDots}
                                    onToggle={() => onUpdate({ showTradeDots: !s.showTradeDots })}
                                />
                                {s.showTradeDots && (
                                    <div className="mt-3">
                                        <label className="block text-[11px] text-white/40 mb-1">
                                            Dot size multiplier - {s.tradeDotsSizeMult}x
                                        </label>
                                        <Slider
                                            value={[s.tradeDotsSizeMult]}
                                            onValueChange={([v]) =>
                                                onUpdate({ tradeDotsSizeMult: v })
                                            }
                                            min={0}
                                            max={5}
                                            step={0.1}
                                            className="w-full"
                                        />
                                        <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                            {[0, 1, 2, 3, 4, 5].map((v) => (
                                                <span key={v}>{v}x</span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </Section>

                            <Section label="Heatmap">
                                <InlineToggleRow
                                    label="Show heatmap"
                                    active={s.showHeatmap}
                                    onToggle={() => onUpdate({ showHeatmap: !s.showHeatmap })}
                                />
                                {s.showHeatmap && (
                                    <div className="flex flex-col gap-3">
                                        <div>
                                            <label className="block text-[11px] text-white/40 mb-1">
                                                Contrast - {Math.round(s.heatmapContrast * 100)}
                                            </label>
                                            <Slider
                                                value={[s.heatmapContrast]}
                                                onValueChange={([v]) => {
                                                    onUpdate({ heatmapContrast: v });
                                                }}
                                                min={0}
                                                max={1}
                                                step={0.01}
                                                className="w-full"
                                            />
                                            <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                                <span>0</span>
                                                <span>50</span>
                                                <span>100</span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </Section>

                            <Section label={`Resampling delay - ${s.resamplingDebounce}ms`}>
                                <Slider
                                    value={[s.resamplingDebounce]}
                                    onValueChange={([v]) => onUpdate({ resamplingDebounce: v })}
                                    min={0}
                                    max={1000}
                                    step={1}
                                    className="w-full"
                                />
                                <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                    {[0, 200, 400, 600, 800, 1000].map((v) => (
                                        <span key={v}>{v}ms</span>
                                    ))}
                                </div>
                            </Section>

                            <Section label="Horizon scroll animation">
                                <div className="flex gap-1.5 mb-3">
                                    {(['none', 'linear', 'easeOut', 'easeInOut'] as const).map(
                                        (m) => (
                                            <ToggleChip
                                                key={m}
                                                active={s.horizonScrollEasing === m}
                                                onClick={() => onUpdate({ horizonScrollEasing: m })}
                                            >
                                                {m === 'none'
                                                    ? 'None'
                                                    : m === 'linear'
                                                      ? 'Linear'
                                                      : m === 'easeOut'
                                                        ? 'Ease out'
                                                        : 'Ease in-out'}
                                            </ToggleChip>
                                        ),
                                    )}
                                </div>
                                {s.horizonScrollEasing !== 'none' && (
                                    <div className="mt-2">
                                        <Section label={`Duration - ${s.horizonScrollDuration}ms`}>
                                            <Slider
                                                value={[s.horizonScrollDuration]}
                                                onValueChange={([v]) =>
                                                    onUpdate({ horizonScrollDuration: v })
                                                }
                                                min={20}
                                                max={500}
                                                step={5}
                                                className="w-full"
                                            />
                                            <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                                {[20, 100, 200, 300, 400, 500].map((v) => (
                                                    <span key={v}>{v}ms</span>
                                                ))}
                                            </div>
                                        </Section>
                                    </div>
                                )}
                            </Section>

                            <TradingViewImportSection onUpdate={onUpdate} />

                            <SavedDataSection active={tab === 'chart'} />

                            <ResetRow
                                onReset={() =>
                                    onUpdate({
                                        backgroundColor: DEFAULT_CHART_SETTINGS.backgroundColor,
                                        axisBackgroundColor:
                                            DEFAULT_CHART_SETTINGS.axisBackgroundColor,
                                        showBidLine: DEFAULT_CHART_SETTINGS.showBidLine,
                                        showAskLine: DEFAULT_CHART_SETTINGS.showAskLine,
                                        showMidLine: DEFAULT_CHART_SETTINGS.showMidLine,
                                        showLastTradeLine: DEFAULT_CHART_SETTINGS.showLastTradeLine,
                                        showTradeDots: DEFAULT_CHART_SETTINGS.showTradeDots,
                                        tradeDotsSizeMult: DEFAULT_CHART_SETTINGS.tradeDotsSizeMult,
                                        heatmapContrast: DEFAULT_CHART_SETTINGS.heatmapContrast,
                                        heatmapColorBid: DEFAULT_CHART_SETTINGS.heatmapColorBid,
                                        heatmapColorAsk: DEFAULT_CHART_SETTINGS.heatmapColorAsk,
                                        priceLineVisible: DEFAULT_CHART_SETTINGS.priceLineVisible,
                                        showFills: DEFAULT_CHART_SETTINGS.showFills,
                                        priceLineColor: DEFAULT_CHART_SETTINGS.priceLineColor,
                                        sessionHighlightEnabled:
                                            DEFAULT_CHART_SETTINGS.sessionHighlightEnabled,
                                        sessionHighlightColor:
                                            DEFAULT_CHART_SETTINGS.sessionHighlightColor,
                                        resamplingDebounce:
                                            DEFAULT_CHART_SETTINGS.resamplingDebounce,
                                        horizonScrollEasing:
                                            DEFAULT_CHART_SETTINGS.horizonScrollEasing,
                                        horizonScrollDuration:
                                            DEFAULT_CHART_SETTINGS.horizonScrollDuration,
                                    })
                                }
                            />
                        </div>
                    )}

                    {tab === 'timezone' && (
                        <div className="flex flex-col gap-5">
                            <Section label="Timezone">
                                <TimezoneSelect
                                    value={s.timezone}
                                    onChange={(tz) => onUpdate({ timezone: tz })}
                                    use24Hour={s.use24HourClock}
                                    onOpenChange={setTzSelectOpen}
                                    horizon={horizon}
                                />
                                {tzSelectOpen && <div className="h-[19rem]" />}
                            </Section>

                            <Section label="Display options">
                                <div className="flex flex-col gap-2">
                                    <InlineToggleRow
                                        label="24-hour clock"
                                        active={s.use24HourClock}
                                        onToggle={() =>
                                            onUpdate({ use24HourClock: !s.use24HourClock })
                                        }
                                    />
                                </div>
                            </Section>

                            <ResetRow
                                onReset={() =>
                                    onUpdate({
                                        timezone: DEFAULT_CHART_SETTINGS.timezone,
                                        use24HourClock: DEFAULT_CHART_SETTINGS.use24HourClock,
                                        showTimezoneLabel: DEFAULT_CHART_SETTINGS.showTimezoneLabel,
                                    })
                                }
                            />
                        </div>
                    )}

                    {tab === 'plugin' && (
                        <div className="flex flex-col gap-5">
                            {pluginSchema.map((field, i) => (
                                <StyleFieldControl
                                    key={fieldKey(field, i)}
                                    field={field}
                                    drawing={pluginValues}
                                    onUpdate={updatePluginSetting}
                                />
                            ))}
                            <ResetRow
                                onReset={() =>
                                    onUpdate({
                                        pluginSettings: {
                                            ...allPluginSettings,
                                            [pluginId]: {
                                                ...(pluginChartType?.defaultSettings ?? {}),
                                            },
                                        },
                                    })
                                }
                            />
                        </div>
                    )}
                </div>
                <div className="px-5 py-1 border-t border-white/6 shrink-0 pt-0">
                    <a href="https://christtrade.com" className="text-[10px] text-white/20 select-none font-mono">
                        ChristTrade Depth 0.12.21
                    </a>
                </div>
            </div>
        </>
    );
}

function TradingViewImportSection({ onUpdate }: { onUpdate: (p: Partial<ChartSettings>) => void }) {
    const [available, setAvailable] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [done, setDone] = useState(false);

    useEffect(() => setAvailable(hasTradingViewSettings()), []);

    useEffect(() => {
        if (!confirm) return;
        const t = setTimeout(() => setConfirm(false), 4000);
        return () => clearTimeout(t);
    }, [confirm]);

    if (!available || done) return null;

    const runImport = () => {
        if (!confirm) {
            setConfirm(true);
            return;
        }
        const patch = readTradingViewChartSettings();
        if (patch) onUpdate(patch);
        importTradingViewSettings({ force: true });
        setConfirm(false);
        setDone(true);
    };

    return (
        <Section label="TradingView">
            <p className="text-[11px] text-white/30 leading-relaxed">
                Found TradingView chart preferences saved in this browser. Importing copies over
                colors, grid, margins, chart type and favorite drawings — anything without an
                equivalent here keeps its current value.
            </p>
            <button
                className={cn(
                    'flex items-center gap-2 text-[11px] transition-colors mt-1 self-start',
                    confirm
                        ? 'text-amber-400 hover:text-amber-300'
                        : 'text-white/30 hover:text-white/60',
                )}
                onClick={runImport}
            >
                <Download size={11} />
                {confirm
                    ? 'Click again to overwrite your current settings'
                    : 'Import TradingView settings'}
            </button>
        </Section>
    );
}

function SavedDataSection({ active }: { active: boolean }) {
    const [enabled, setEnabled] = useState(isPersistenceEnabled);
    const [bytes, setBytes] = useState(0);
    const [confirmClear, setConfirmClear] = useState(false);

    useEffect(() => {
        if (active) setBytes(chartStorageSize());
    }, [active, enabled]);

    useEffect(() => {
        if (!confirmClear) return;
        const t = setTimeout(() => setConfirmClear(false), 4000);
        return () => clearTimeout(t);
    }, [confirmClear]);

    const toggle = () => {
        const next = !enabled;
        setPersistenceEnabled(next);
        setEnabled(next);
    };

    const clear = () => {
        if (!confirmClear) {
            setConfirmClear(true);
            return;
        }
        clearChartStorage();
        setConfirmClear(false);
        setBytes(chartStorageSize());
    };

    return (
        <Section label="Saved data">
            <InlineToggleRow
                label="Save settings to this device"
                active={enabled}
                onToggle={toggle}
            />
            <p className="text-[11px] text-white/30 leading-relaxed">
                {enabled
                    ? `Chart settings, favorite timeframes, drawing templates and plugin state are kept in this browser${bytes > 0 ? ` (${formatBytes(bytes)})` : ''}. They never leave your device.`
                    : 'Nothing is written to this browser. Every reload starts from defaults; anything saved earlier is ignored until you switch this back on.'}
            </p>
            <button
                className={cn(
                    'flex items-center gap-2 text-[11px] transition-colors mt-1 self-start',
                    confirmClear
                        ? 'text-red-400 hover:text-red-300'
                        : 'text-white/30 hover:text-white/60',
                )}
                onClick={clear}
            >
                <Trash2 size={11} />
                {confirmClear ? 'Click again to erase — this cannot be undone' : 'Clear saved data'}
            </button>
        </Section>
    );
}

function formatBytes(n: number): string {
    return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-2.5">
            <p className="text-[11px] font-medium text-white/40 uppercase tracking-wider">
                {label}
            </p>
            {children}
        </div>
    );
}

function ResetRow({ onReset }: { onReset: () => void }) {
    return (
        <button
            className="flex items-center gap-2 text-[11px] text-white/30 hover:text-white/60 transition-colors mt-1"
            onClick={onReset}
        >
            <RotateCcw size={11} /> Reset to defaults
        </button>
    );
}

function InlineToggleRow({
    label,
    active,
    onToggle,
}: {
    label: string;
    active: boolean;
    onToggle: () => void;
}) {
    return (
        <button
            className={cn(
                'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-colors',
                active
                    ? 'border-blue-500/30 bg-blue-500/8 text-white'
                    : 'border-white/6 bg-white/3 text-white/50 hover:border-white/12 hover:bg-white/5 hover:text-white/70',
            )}
            onClick={onToggle}
        >
            <span className="text-[12px]">{label}</span>
            <Switch
                checked={active}
                onCheckedChange={onToggle}
                className="data-[state=checked]:bg-blue-500"
            />
        </button>
    );
}

function ToggleChip({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-medium transition-colors',
                active
                    ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
                    : 'border-white/8 bg-white/4 text-white/40 hover:border-white/15 hover:bg-white/7 hover:text-white/70',
            )}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function ColorRow({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
}) {
    return (
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-white/6 bg-white/3">
            <span className="text-[12px] text-white/60">{label}</span>
            <div className="flex items-center gap-2">
                <ColorPickerReact
                    onChange={onChange}
                    value={value}
                    className="w-8 h-8 rounded-md border-2 border-border/50"
                />
            </div>
        </div>
    );
}
