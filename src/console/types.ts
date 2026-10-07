import type { ChartEvents } from '../core/TypedEventBus';
import type { ChartSettings } from '../lib/types/chart-settings';

export type ArgType =
    | { kind: 'string' }
    | { kind: 'number' }
    | { kind: 'boolean' }
    | { kind: 'bigint' }
    /** A moment as epoch ns ("now"/"-1h"/"2024-01-05T09:30"/epoch s/ms/ns) */
    | { kind: 'time' }
    /** A length in ns ("1h30m"/"250ms") */
    | { kind: 'duration' }
    | { kind: 'color' }
    /** `open` when the union also takes any string (ex plugin chart type ids) */
    | { kind: 'enum'; values: string[]; open?: boolean }
    | { kind: 'list'; of: ArgType }
    /** a named type the console needs a parser for so like `Timeframe` from "5m" */
    | { kind: 'named'; name: string }
    | { kind: 'json' };

export type ArgSpec = {
    name: string;
    type: ArgType;
    optional?: boolean;
    nullable?: boolean;
    doc?: string;
};

export type EventSpec = {
    event: keyof ChartEvents;
    /** command can be run, event can only be listened to */
    kind: 'command' | 'event';
    /** Plumbing, hidden unless dev mode is on */
    dev?: boolean;
    /** obj payloads spread into named args, anything else is just a single `value` arg */
    spread?: boolean;
    args: ArgSpec[];
    doc?: string;
};

export type CvarSpec = {
    name: keyof ChartSettings;
    type: ArgType;
    nullable?: boolean;
    group?: string;
    doc?: string;
};
