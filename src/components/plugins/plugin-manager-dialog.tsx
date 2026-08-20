'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    BadgeCheck,
    BarChart2,
    ChevronDown,
    Cpu,
    Database,
    DraftingCompass,
    LineChart,
    Plug,
    Search,
    TrendingUp,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../ui/dialog';
import { Switch } from '../ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { TypedEventBus } from '../../core/TypedEventBus';
import type { DepthChart } from '../../core';
import type { PluginType } from '../../interfaces/plugins/IChartPlugin';
import { DropdownMenuCheckboxItem } from '../ui/dropdown-menu';
import { Checkbox } from '../ui/checkbox'

type Kind = PluginType | 'unknown';

interface Row {
    id: string;
    name: string;
    kind: Kind;
    group?: string;
    description?: string;
    /** worker running, capabilities registered */
    loaded: boolean;
    /** indicators only: at least one instance on a pane */
    active: boolean;
    /** load it again next time the chart opens */
    autostart: boolean;
    /** the host has code for it, so it can be loaded from here */
    available: boolean;
}

const KIND_META: Record<Kind, { label: string; Icon: typeof LineChart }> = {
    indicator: { label: 'Indicators', Icon: LineChart },
    strategy: { label: 'Strategies', Icon: TrendingUp },
    drawing: { label: 'Drawings', Icon: DraftingCompass },
    'chart-type': { label: 'Chart types', Icon: BarChart2 },
    extension: { label: 'Extensions', Icon: Cpu },
    'data-source': { label: 'Data sources', Icon: Database },
    unknown: { label: 'Other', Icon: Plug },
};

const KIND_ORDER: Kind[] = [
    'extension',
    'indicator',
    'strategy',
    'drawing',
    'chart-type',
    'data-source',
    'unknown',
];

function buildRows(chart: DepthChart): Row[] {
    const startup = chart.getPluginStartup();
    const { installed, active } = chart.getPluginState();
    const rows = new Map<string, Row>();

    for (const entry of chart.getPluginCatalog()) {
        rows.set(entry.id, {
            id: entry.id,
            name: entry.name?.trim() || entry.id,
            kind: entry.type ?? 'unknown',
            group: entry.group,
            description: entry.description,
            loaded: installed.has(entry.id),
            active: active.has(entry.id),
            autostart: startup[entry.id]?.autostart === true,
            available: true,
        });
    }

    // loaded without being in the catalog: the host installed it itself. worth
    // showing - it is running - but there is no code here to load it back with,
    // so it cant be switched from this dialog. the chart's own built-in
    // indicators are left out entirely, they belong in the indicators picker
    for (const p of chart.getInstalledPlugins()) {
        if (rows.has(p.id) || p.id.startsWith('builtin:')) continue;
        rows.set(p.id, {
            id: p.id,
            name: p.name,
            kind: p.type ?? 'unknown',
            loaded: true,
            active: active.has(p.id),
            autostart: startup[p.id]?.autostart === true,
            available: false,
        });
    }

    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function PluginRow({
    row,
    problem,
    onToggleLoaded,
    onToggleActive,
    onToggleAutostart,
}: {
    row: Row;
    problem?: string;
    onToggleLoaded: (on: boolean) => void;
    onToggleActive: (on: boolean) => void;
    onToggleAutostart: (on: boolean) => void;
}) {
    const { Icon } = KIND_META[row.kind];

    return (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/40 duration-200 hover:duration-0 transition-colors">
            <Icon size={14} className="shrink-0 text-muted-foreground" />

            <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[13px] text-foreground truncate">{row.name}</span>
                    {row.loaded && row.kind === 'indicator' && (
                        <span
                            className={cn(
                                'shrink-0 px-1.5 h-4 rounded text-[10px] leading-4 font-medium',
                                row.active
                                    ? 'bg-primary/15 text-primary'
                                    : 'bg-muted text-muted-foreground',
                            )}
                        >
                            {row.active ? 'on chart' : 'loaded'}
                        </span>
                    )}
                    {!row.available && (
                        <span className="shrink-0 px-1.5 h-4 rounded bg-muted text-muted-foreground text-[10px] leading-4">
                            bundled
                        </span>
                    )}
                </div>
                {problem ? (
                    <span className="flex items-center gap-1 text-[11px] text-amber-500 truncate">
                        <AlertTriangle size={10} className="shrink-0" />
                        {problem}
                    </span>
                ) : (
                    row.description && (
                        <span className="text-[11px] text-muted-foreground truncate">
                            {row.description}
                        </span>
                    )
                )}
            </div>

            {row.kind === 'indicator' && (
                <Tooltip delayDuration={500}>
                    <TooltipTrigger asChild>
                        <button
                            disabled={!row.loaded}
                            onClick={() => onToggleActive(!row.active)}
                            className={cn(
                                'shrink-0 h-6 px-2 rounded-md border text-[11px] transition-colors',
                                'disabled:opacity-30 disabled:cursor-not-allowed',
                                row.active
                                    ? 'border-primary/40 text-primary hover:bg-primary/10'
                                    : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
                            )}
                        >
                            {row.active ? 'Remove' : 'Add'}
                        </button>
                    </TooltipTrigger>
                    <TooltipContent className="bg-background border border-border">
                        {row.active ? 'Take it off the panes' : 'Put an instance on the chart'}
                    </TooltipContent>
                </Tooltip>
            )}

            <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                    <div className="shrink-0 flex items-center justify-center w-10">
                        <Checkbox checked={row.autostart} disabled={!row.available} onCheckedChange={onToggleAutostart} className='disabled:opacity-30' />
                    </div>
                </TooltipTrigger>
                <TooltipContent className="bg-background border border-border">
                    Load this plugin whenever the chart opens
                </TooltipContent>
            </Tooltip>

            <Switch
                checked={row.loaded}
                disabled={!row.available}
                onCheckedChange={onToggleLoaded}
                className="shrink-0 data-[state=checked]:bg-blue-500"
            />
        </div>
    );
}

export function PluginManagerDialog({
    chart,
    eventBus,
    open,
    onOpenChange,
    loaded
}: {
    chart: DepthChart;
    eventBus: TypedEventBus;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    loaded: number;
}) {
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const [rows, setRows] = useState<Row[]>([]);
    const [problems, setProblems] = useState<Record<string, string>>({});
    const [query, setQuery] = useState('');

    const refresh = useCallback(() => setRows(buildRows(chart)), [chart]);

    useEffect(() => {
        if (!open) return;
        refresh();
        return chart.onPluginStateChange(refresh);
    }, [chart, open, refresh]);

    // whatever went wrong last, per plugin. the editor owns the full error, this
    // is just so a plugin that is switched on but doing nothing says why
    useEffect(() => {
        const unsubs = [
            eventBus.on('plugin:script-error', ({ id, error }) =>
                setProblems((prev) => ({ ...prev, [id]: error })),
            ),
            eventBus.on('plugin:incompatible', ({ id, required, actual }) =>
                setProblems((prev) => ({
                    ...prev,
                    [id]: `needs ${required} data, this chart has ${actual}`,
                })),
            ),
            eventBus.on('plugin:installed', ({ id }) =>
                setProblems((prev) => {
                    if (!(id in prev)) return prev;
                    const next = { ...prev };
                    delete next[id];
                    return next;
                }),
            ),
        ];
        return () => unsubs.forEach((fn) => fn());
    }, [eventBus]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return rows;
        return rows.filter(
            (r) =>
                r.name.toLowerCase().includes(q) ||
                r.id.toLowerCase().includes(q) ||
                r.group?.toLowerCase().includes(q),
        );
    }, [rows, query]);

    const grouped = useMemo(
        () =>
            KIND_ORDER.map((kind) => ({
                kind,
                items: filtered.filter((r) => r.kind === kind),
            })).filter((g) => g.items.length > 0),
        [filtered],
    );

    const toggleLoaded = (row: Row, on: boolean) => {
        if (on) chart.loadPlugin(row.id);
        else chart.unloadPlugin(row.id);
        refresh();
    };

    const toggleActive = (row: Row, on: boolean) => {
        if (on) chart.add(row.id);
        else chart.remove(row.id);
        chart.setPluginStartup(row.id, { activate: on });
        refresh();
    };

    const toggleAutostart = (row: Row, on: boolean) => {
        chart.setPluginStartup(row.id, { autostart: on });
        refresh();
    };

    const loadedCount = rows.filter((r) => r.loaded).length;

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                onOpenChange(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onOpenChange(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <div className="relative" ref={popoverRef}>
            <Tooltip delayDuration={700}>
                <TooltipTrigger asChild>
                    <button
                        onClick={() => onOpenChange(!open)}
                        className={cn(
                            'flex items-center gap-1.5 h-7 px-2 rounded-md transition-colors font-medium',
                            'text-[12px] text-gray-300 hover:text-white hover:text-foreground hover:bg-muted border border-transparent hover:border-border',
                            open && 'border-border bg-muted text-white'
                        )}
                    >
                        <Plug size={13} className="shrink-0" />
                        <span>Plugins</span>
                        <ChevronDown className={cn('w-3 h-3 transition-all duration-200 text-muted-foreground', open && 'rotate-180')} />
                    </button>
                </TooltipTrigger>
                <TooltipContent className="bg-background border border-border">
                    Loaded plugins, and what starts with the chart
                </TooltipContent>
            </Tooltip>
        {open && (
            <div className="absolute right-0 top-full mt-1.5 z-50 flex flex-col w-[30rem] max-h-[35rem] rounded-lg border border-[#1e2128] bg-[#16181d] shadow-2xl overflow-hidden">
                    <div className="px-4 pt-4 pb-3 shrink-0">
                        <div className="text-sm font-medium">Plugins</div>
                        <div className="text-xs">
                            {loadedCount} of {rows.length} loaded. Anything switched on here comes
                            back the next time you open the chart.
                        </div>
                    </div>

                    <div className="flex items-center gap-2 px-4 h-10 border-y border-border shrink-0">
                        <Search size={13} className="shrink-0 text-muted-foreground" />
                        <input
                            autoFocus
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search plugins"
                            className="flex-1 h-full bg-transparent outline-none text-[13px] text-foreground placeholder:text-muted-foreground/60"
                        />
                    </div>

                    <div className="flex items-center gap-3 px-4 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground/60 border-b border-border shrink-0">
                        <span className="flex-1">Plugin</span>
                        <span className="w-10 text-center">Startup</span>
                        <span className="w-9 text-right">On</span>
                    </div>

                    <div className="flex-1 overflow-y-auto min-h-0 py-1">
                        {grouped.length === 0 ? (
                            <div className="flex flex-col items-center gap-1.5 py-14 text-center">
                                <Plug size={18} className="text-muted-foreground/30" />
                                <p className="text-xs text-muted-foreground/60">
                                    {rows.length === 0
                                        ? 'No plugins yet. Write one in the script editor.'
                                        : 'Nothing matches that.'}
                                </p>
                            </div>
                        ) : (
                            grouped.map(({ kind, items }) => (
                                <div key={kind} className="pb-1">
                                    <p className="px-4 pt-2 pb-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/50">
                                        {KIND_META[kind].label}
                                    </p>
                                    <div className="px-1">
                                        {items.map((row) => (
                                            <PluginRow
                                                key={row.id}
                                                row={row}
                                                problem={problems[row.id]}
                                                onToggleLoaded={(on) => toggleLoaded(row, on)}
                                                onToggleActive={(on) => toggleActive(row, on)}
                                                onToggleAutostart={(on) => toggleAutostart(row, on)}
                                            />
                                        ))}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
            </div>
        )}
        </div>
    );
}

export function PluginManagerButton({
    chart,
    eventBus,
}: {
    chart: DepthChart;
    eventBus: TypedEventBus;
}) {
    const [open, setOpen] = useState(false);
    // builtins dont count: they are the chart's own indicators, not something the
    // user loaded, and the dialog doesnt list them
    const countLoaded = (ids: Set<string>) =>
        [...ids].filter((id) => !id.startsWith('builtin:')).length;
    const [loaded, setLoaded] = useState(() => countLoaded(chart.getPluginState().installed));

    useEffect(() => {
        setLoaded(countLoaded(chart.getPluginState().installed));
        return chart.onPluginStateChange((s) => setLoaded(countLoaded(s.installed)));
    }, [chart]);

    // so a host can offer its own way in - a menu item, a keybinding
    useEffect(() => eventBus.on('plugin:open-manager', () => setOpen(true)), [eventBus]);

    // nothing to manage on a chart with no plugin story at all
    if (loaded === 0 && chart.getPluginCatalog().length === 0) return null;

    return (
        <PluginManagerDialog
            chart={chart}
            eventBus={eventBus}
            open={open}
            onOpenChange={setOpen}
            loaded={loaded}
        />
    );
}
