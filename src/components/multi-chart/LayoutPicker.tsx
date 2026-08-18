'use client';

import React, { useCallback } from 'react';
import { Button } from '../ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Separator } from '../ui/separator';
import { Switch } from '../ui/switch';
import type { SyncInLayout } from '../../lib/types/layout-sync';

export type Preset = {
    id: string;
    label: string;
    count: number;
    cols: number;
    rows: number;
    areas: string;
};

export type { SyncInLayout };

export const PRESETS: Preset[] = [
    { id: '1', label: '1', count: 1, cols: 1, rows: 1, areas: '"a"' },

    { id: '2h', label: '2', count: 2, cols: 2, rows: 1, areas: '"a b"' },
    { id: '2v', label: '2', count: 2, cols: 1, rows: 2, areas: '"a" "b"' },

    { id: '3h', label: '3', count: 3, cols: 3, rows: 1, areas: '"a b c"' },
    { id: '3v', label: '3', count: 3, cols: 1, rows: 3, areas: '"a" "b" "c"' },
    { id: '3r', label: '3', count: 3, cols: 2, rows: 2, areas: '"a b" "a c"' },
    { id: '3l', label: '3', count: 3, cols: 2, rows: 2, areas: '"a b" "c b"' },
    { id: '3t', label: '3', count: 3, cols: 2, rows: 2, areas: '"a a" "b c"' },
    { id: '3b', label: '3', count: 3, cols: 2, rows: 2, areas: '"a b" "c c"' },

    { id: '4g', label: '4', count: 4, cols: 2, rows: 2, areas: '"a b" "c d"' },
    { id: '4h', label: '4', count: 4, cols: 4, rows: 1, areas: '"a b c d"' },
    { id: '4v', label: '4', count: 4, cols: 1, rows: 4, areas: '"a" "b" "c" "d"' },
    { id: '4l', label: '4', count: 4, cols: 2, rows: 3, areas: '"a b" "a c" "a d"' },
    { id: '4r', label: '4', count: 4, cols: 2, rows: 3, areas: '"a b" "c b" "d b"' },
    { id: '4b', label: '4', count: 4, cols: 3, rows: 2, areas: '"a a a" "b c d"' },
    { id: '4t', label: '4', count: 4, cols: 3, rows: 2, areas: '"a b c" "d d d"' },
    { id: '4j', label: '4', count: 4, cols: 3, rows: 2, areas: '"a b c" "a b d"' },
    { id: '4k', label: '4', count: 4, cols: 3, rows: 2, areas: '"a b c" "d b c"' },
    { id: '4i', label: '4', count: 4, cols: 2, rows: 3, areas: '"a b" "c c" "d d"' },

    { id: '5t', label: '5', count: 5, cols: 4, rows: 2, areas: '"a a a a" "b c d e"' },
    { id: '5h', label: '5', count: 5, cols: 5, rows: 1, areas: '"a b c d e"' },
    { id: '5v', label: '5', count: 5, cols: 1, rows: 5, areas: '"a" "b" "c" "d" "e"' },
    { id: '5l', label: '5', count: 5, cols: 2, rows: 4, areas: '"a b" "a c" "a d" "a e"' },
    { id: '5r', label: '5', count: 5, cols: 2, rows: 4, areas: '"a b" "c b" "d b" "e b"' },
    { id: '5b', label: '5', count: 5, cols: 4, rows: 2, areas: '"a b c d" "e e e e"' },
    { id: '5j', label: '5', count: 5, cols: 3, rows: 3, areas: '"a b c" "a b d" "a b e"' },
    { id: '5k', label: '5', count: 5, cols: 3, rows: 3, areas: '"a b c" "d b c" "e b c"' },

    { id: '6g', label: '6', count: 6, cols: 3, rows: 2, areas: '"a b c" "d e f"' },
    { id: '6h', label: '6', count: 6, cols: 6, rows: 1, areas: '"a b c d e f"' },
    { id: '6v', label: '6', count: 6, cols: 1, rows: 6, areas: '"a" "b" "c" "d" "e" "f"' },
    { id: '6f', label: '6', count: 6, cols: 2, rows: 3, areas: '"a b" "c d" "e f"' },
    { id: '6t', label: '6', count: 6, cols: 4, rows: 2, areas: '"a a b b" "c d e f"' },
    { id: '6b', label: '6', count: 6, cols: 4, rows: 2, areas: '"a b c d" "e e f f"' },

    { id: '7h', label: '7', count: 7, cols: 7, rows: 1, areas: '"a b c d e f g"' },
    { id: '7l', label: '7', count: 7, cols: 2, rows: 6, areas: '"a b" "a c" "a d" "a e" "a f" "a g"' },

    { id: '8g', label: '8', count: 8, cols: 4, rows: 2, areas: '"a b c d" "e f g h"' },
    { id: '8h', label: '8', count: 8, cols: 2, rows: 4, areas: '"a b" "c d" "e f" "g h"' },
];

export const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function Thumb({ p, active, size = 32 }: { p: Preset; active: boolean; size?: number }) {
    const aspect = 24 / 28;
    const W = size;
    const H = size * aspect;

    const rows = (p.areas.match(/"([^"]+)"/g) ?? ['"a"']).map((r) =>
        r.replace(/"/g, '').trim().split(/\s+/),
    );

    const numRows = rows.length;
    const numCols = rows[0].length;
    const cw = W / numCols;
    const rh = H / numRows;

    const lines: React.ReactNode[] = [];

    // vertical dividers: boundary between col j and j+1, per row
    for (let i = 0; i < numRows; i++) {
        for (let j = 0; j < numCols - 1; j++) {
            if (rows[i][j] !== rows[i][j + 1]) {
                const x = (j + 1) * cw;
                lines.push(
                    <line key={`v-${i}-${j}`} x1={x} y1={i * rh} x2={x} y2={(i + 1) * rh} strokeWidth={1} />
                );
            }
        }
    }

    // horizontal dividers: boundary between row i and i+1, per column
    for (let i = 0; i < numRows - 1; i++) {
        for (let j = 0; j < numCols; j++) {
            if (rows[i][j] !== rows[i + 1][j]) {
                const y = (i + 1) * rh;
                lines.push(
                    <line key={`h-${i}-${j}`} x1={j * cw} y1={y} x2={(j + 1) * cw} y2={y} strokeWidth={1} />
                );
            }
        }
    }

    return (
        <div className={`rounded-md p-[5px] ${active ? 'bg-[#272b35]' : 'bg-transparent'} transition stroke-[#A8AFBD] group-hover:stroke-white`}>
            <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
                <rect x={0.5} y={0.5} width={W - 1} height={H - 1} rx={2.5} fill="transparent" strokeWidth={1} />
                {lines}
            </svg>
        </div>
    );
}

const SYNC_OPTIONS: { key: keyof SyncInLayout; label: string; hint: string }[] = [
    { key: 'symbol', label: 'Symbol', hint: 'All charts follow the symbol you pick' },
    { key: 'interval', label: 'Interval', hint: 'All charts follow the timeframe you pick' },
    { key: 'crosshair', label: 'Crosshair', hint: 'Show the hovered bar on every chart' },
    { key: 'time', label: 'Time', hint: 'Scrolling one chart scrolls the rest; zoom stays per chart' },
    { key: 'dateRange', label: 'Date Range', hint: 'Every chart shows the exact same range' },
];

export function LayoutPicker({
    current,
    onChange,
    syncInLayout,
    setSyncInLayout,
}: {
    current: Preset;
    onChange: (p: Preset) => void;
    syncInLayout: SyncInLayout;
    setSyncInLayout: (patch: SyncInLayout) => void;
}) {
    const groupPresets = useCallback(() => {
        let cursor = 1;
        let working: Preset[] = [];
        const result: Preset[][] = [];

        for (const preset of PRESETS) {
            if (preset.count !== cursor) {
                cursor = preset.count;
                if (working.length) result.push(working);
                working = [];
            }
            working.push(preset);
        }

        if (working.length) result.push(working);
        return result;
    }, []);

    const presetsGrouped = groupPresets();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" className="group hover:bg-muted w-7 p-0 h-7 border-none">
                    <Thumb p={current} active={false} size={22} />
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent className="p-3 flex flex-col gap-1.5 w-fit">
                <div className="text-xs text-muted-foreground tracking-wide border-b pb-2">
                    LAYOUT
                </div>

                {presetsGrouped.map((group, i) => (
                    <React.Fragment key={group[0]?.count ?? i}>
                        <div className="flex gap-2 items-center w-full">
                            <div className="text-xs text-muted-foreground w-4">{group[0]?.count}</div>

                            <div className="flex gap-1 w-full">
                                {group.map((p) => {
                                    const on = p.id === current.id;
                                    return (
                                        <DropdownMenuItem
                                            key={p.id}
                                            onClick={() => onChange(p)}
                                            className="flex flex-col items-center gap-1 p-0 rounded-md w-fit cursor-pointer hover:!bg-[#272b35] group"
                                        >
                                            <Thumb p={p} active={on} size={20} />
                                        </DropdownMenuItem>
                                    );
                                })}
                            </div>
                        </div>
                        {i < presetsGrouped.length - 1 && <Separator />}
                    </React.Fragment>
                ))}

                <div className="text-xs text-muted-foreground tracking-wide border-b pb-2 space-y-2 mt-4">
                    SYNC IN LAYOUT
                </div>

                <div className="flex flex-col gap-2 text-[13px] text-muted-foreground font-[400]">
                    {SYNC_OPTIONS.map(({ key, label, hint }) => (
                        <label
                            key={key}
                            title={hint}
                            className="flex w-full justify-between items-center gap-6 cursor-pointer"
                        >
                            <span>{label}</span>
                            <Switch
                                checked={syncInLayout[key]}
                                onCheckedChange={(on) =>
                                    setSyncInLayout({ ...syncInLayout, [key]: on })
                                }
                                className="data-[state=checked]:bg-blue-500"
                            />
                        </label>
                    ))}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
