// the single source of truth for mutable chart state shared across engines.
// reads through state.get() are synchronous and free; writes through set() also
// emit the matching bus event so React and everything else stays in sync.

import type { TypedEventBus } from './TypedEventBus';
import type { ActiveDrawingTool } from '../lib/types/drawing-types';
import type { FootprintOptions } from '../lib/types/footprint';
import { Timeframe } from '../lib/timeframes';
import type { SyncInLayout } from '../lib/types/layout-sync';

// Shape
export interface ChartStateShape {
    /** Drawing tool armed for creation. `cursor` when nothing is armed. */
    activeTool: ActiveDrawingTool;

    /** Id of the selected drawing, or null. Kept apart from activeTool, since
     *  selecting a drawing must not arm its tool. */
    selectedDrawingId: string | null;

    /** Symbol being charted. */
    symbol: string;

    /** Footprint display options. */
    fpOptions: FootprintOptions;

    /** Whether playback is currently running. */
    isPlaying: boolean;

    /** ISO horizon string, used by DataEngine to align the initial data. */
    horizonIso: string;

    timeframe: Timeframe;

    layout: {
        id: string;
        label: string;
        count: number;
        cols: number;
        rows: number;
        areas: string;
    };

    /** Which properties a layout's cells share - crosshair, symbol, interval,
     *  time, date range. */
    syncInLayout?: SyncInLayout;

    /** Divider sizes (fr) for the grid, plus the focused pane index. */
    gridColSizes?: number[];
    gridRowSizes?: number[];
    focusedPane?: number;

    // anything added here is readable by every engine with no new subscription
}


// ChartState
export class ChartState {
    private _state: ChartStateShape;

    constructor(initial: ChartStateShape) {
        // shallow clone so the caller's object isnt mutated
        this._state = { ...initial };
    }

    get<K extends keyof ChartStateShape>(key: K): ChartStateShape[K] {
        return this._state[key];
    }

    /** Shallow-frozen snapshot of the whole state. For plugins and debugging,
     *  not a hot path. */
    snapshot(): Readonly<ChartStateShape> {
        return Object.freeze({ ...this._state });
    }

    // every mutation goes through here so the events fire consistently
    set<K extends keyof ChartStateShape>(
        key: K,
        value: ChartStateShape[K],
        eventBus?: TypedEventBus,
    ): void {
        if (this._state[key] === value) return;
        this._state[key] = value;

        if (!eventBus) return;

        switch (key) {
            case 'activeTool':
                eventBus.emit('chart:set-tool', { tool: value as ActiveDrawingTool });
                break;
            case 'symbol':
                eventBus.emit('chart:set-symbol-focused', { symbol: value as string });
                break;
            case 'timeframe':
                eventBus.emit('chart:set-timeframe', { tf: value as Timeframe });
                eventBus.emit('timeframe:change', { tf: value as Timeframe });
                break;
            case 'isPlaying':
                if (value as boolean) eventBus.emit('playback:play', undefined);
                else eventBus.emit('playback:pause', undefined);
                break;
        }
    }

    /**
     * Update several fields at once, emitting for each changed one that has a
     * mapping. For when fields move together, like a timeframe switch touching
     * both barNs and fpOptions.
     */
    patch(partial: Partial<ChartStateShape>, eventBus?: TypedEventBus): void {
        for (const key of Object.keys(partial) as Array<keyof ChartStateShape>) {
            this.set(key, partial[key] as any, eventBus);
        }
    }
}
