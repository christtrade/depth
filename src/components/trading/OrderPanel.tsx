'use client';

import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    ArrowLeftRight,
    ChevronDown,
    ChevronUp,
    Link2,
    Unlink,
    X,
} from 'lucide-react';
import { nanoid } from 'nanoid';

import type { TypedEventBus } from '../../core/TypedEventBus';
import type { ContractSpec } from '../../interfaces/IDataAdapter';
import type { PlaceOrderRequest } from '../../lib/matchingEngine';
import type { TradeLine } from '../../lib/types';
import type { ActiveDrawingTool, PositionDrawing } from '../../lib/types/drawing-types';
import type { OrderSide, OrderType, TimeInForce } from '../../lib/types/trading-types';
import { Button } from '../ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Switch } from '../ui/switch';
import {
    AMOUNT_MODES,
    amountFromQty,
    deriveTicket,
    levelPrice,
    levelTicks,
    priceDecimals,
    qtyDecimals,
    roundToTick,
    tickSizeOf,
    ticketFromPosition,
    ticksBetween,
    type AmountMode,
    type Ticket,
} from './order-math';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const UP = '#2962ff';
const DOWN = '#f23645';

const PANEL = '#16181d';
const WELL = '#0f1116';
const INSET = '#1b1e25';
const EDGE = '#22262e';
const HAIRLINE = '#1e2128';

const PANEL_W = 340;
const VIEWPORT_PADDING = 12;

let rememberedPosition: { x: number; y: number } | null = null;

interface RememberedTicket {
    side: OrderSide;
    type: OrderType;
    tif: TimeInForce;
    entry: DualField;
    amountMode: AmountMode;
    amount: string;
    tpOn: boolean;
    slOn: boolean;
    tp: DualField;
    sl: DualField;
    exitsOpen: boolean;
    extrasOpen: boolean;
    reduceOnly: boolean;
    confirmFirst: boolean;
    keepOpen: boolean;
}

let rememberedTicket: RememberedTicket | null = null;

// trading:ticket-requested is sticky on the bus so it can be emitted before
// the panel exists; this stops a later opening from replaying the same request
let consumedTicketRequest: string | null = null;

const clampLeft = (x: number): number =>
    Math.max(
        VIEWPORT_PADDING,
        Math.min(window.innerWidth - PANEL_W - VIEWPORT_PADDING, x),
    );

const clampTop = (y: number, height: number): number => {
    const maxY = window.innerHeight - height - VIEWPORT_PADDING;
    return Math.min(Math.max(VIEWPORT_PADDING, y), Math.max(VIEWPORT_PADDING, maxY));
};

// a value the user can express two ways. only the side they typed is stored;
// its counterpart is derived at render, since keeping both in state and syncing
// them loops the first time the two disagree about rounding
interface DualField {
    fixed: 'price' | 'offset';
    price: string;
    offset: string;
}

const dual = (offset: string | number): DualField => ({
    fixed: 'offset',
    price: '0',
    offset: String(offset),
});

// one tick onto the side the order is meant to rest on. offsets are measured
// from the touch, so seeding zero puts a limit through the market and opens the
// ticket on a validation error the user hasnt earned yet
const restingOffset = (side: OrderSide, type: OrderType): number => {
    if (type === 'limit') return side === 'long' ? -1 : 1;
    if (type === 'stop') return side === 'long' ? 1 : -1;
    return 0;
};

const num = (raw: string): number => {
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : 0;
};

const fmt = (value: number, decimals = 2): string =>
    value.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });

// four places under a dollar: a tick on 0.015 BTC is worth $0.0015, and "0.00"
// would read as costing nothing
const cash = (value: number): string =>
    fmt(value, value !== 0 && Math.abs(value) < 1 ? 4 : 2);

const signedPct = (value: number): string => `${value.toFixed(2)}%`;

function ModeLabel<T extends string>({
    value,
    options,
    onChange,
    prefix,
}: {
    value: T;
    options: { id: T; label: string }[];
    onChange: (next: T) => void;
    prefix?: string;
}) {
    const current = options.find((option) => option.id === value);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className="group flex items-center gap-1 rounded text-[11.5px] text-slate-500 outline-none transition-colors hover:text-slate-300 focus-visible:text-slate-300">
                {prefix ? `${prefix}, ${(current?.label ?? value).toLowerCase()}` : (current?.label ?? value)}
                <ChevronDown className="h-3 w-3 opacity-60 transition-transform group-data-[state=open]:rotate-180" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className="min-w-[172px] border-[#22262e] bg-[#1b1e25] p-1 z-[210]"
            >
                {options.map((option) => (
                    <DropdownMenuItem
                        key={option.id}
                        onSelect={() => onChange(option.id)}
                        className={`cursor-pointer rounded text-[12px] focus:bg-[#272c35] ${
                            option.id === value ? 'text-slate-100' : 'text-slate-400'
                        }`}
                    >
                        {option.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function SwapField({
    value,
    onChange,
    readout,
    readoutUnit,
    onSwap,
    disabled,
    invalid,
    onActivate,
}: {
    value: string;
    onChange: (next: string) => void;
    readout: string;
    readoutUnit: string;
    onSwap: () => void;
    disabled?: boolean;
    invalid?: boolean;
    onActivate?: () => void;
}) {
    return (
        <div
            className="flex h-9 items-stretch overflow-hidden rounded-md border transition-colors focus-within:border-slate-600"
            style={{
                background: WELL,
                borderColor: invalid ? 'rgba(229,83,75,0.5)' : EDGE,
                opacity: disabled ? 0.4 : 1,
            }}
        >
            <input
                type="text"
                inputMode="decimal"
                value={value}
                disabled={disabled && !onActivate}
                onPointerDown={() => disabled && onActivate?.()}
                onFocus={() => disabled && onActivate?.()}
                onChange={(event) => onChange(event.target.value)}
                className="min-w-0 flex-1 bg-transparent px-2.5 text-[12.5px] tabular-nums text-slate-100 outline-none placeholder:text-slate-600"
            />
            <button
                type="button"
                onClick={disabled && onActivate ? onActivate : onSwap}
                disabled={disabled && !onActivate}
                title="Swap which side you set"
                className="flex w-8 shrink-0 items-center justify-center text-slate-600 outline-none transition-colors hover:text-slate-300 focus-visible:text-slate-300 disabled:hover:text-slate-600"
            >
                <ArrowLeftRight className="h-3.5 w-3.5" />
            </button>
            <div className="flex shrink-0 items-center gap-1 pr-2.5 pl-1">
                <span className="text-[12.5px] tabular-nums text-slate-400">
                    {readout}
                </span>
                <span className="text-[10.5px] text-slate-600">{readoutUnit}</span>
            </div>
        </div>
    );
}

interface FigureRow {
    label: string;
    value: string;
    unit?: string;
    tone?: string;
    lead?: string;
}

function Figures({ rows }: { rows: FigureRow[] }) {
    return (
        <div className="flex flex-col gap-1.5 rounded-md p-2.5" style={{ background: INSET }}>
            {rows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3">
                    <span className="text-[11.5px] text-slate-500">{row.label}</span>
                    <span className="flex items-baseline gap-1.5">
                        {row.lead && (
                            <span className="text-[11px] tabular-nums text-slate-500">
                                {row.lead}
                            </span>
                        )}
                        <span
                            className="text-[12px] tabular-nums"
                            style={{ color: row.tone ?? '#cbd5e1' }}
                        >
                            {row.value}
                        </span>
                        {row.unit && (
                            <span className="text-[10px] text-slate-600">{row.unit}</span>
                        )}
                    </span>
                </div>
            ))}
        </div>
    );
}

function RiskReward({
    ticket,
    currencySymbol,
}: {
    ticket: Ticket;
    currencySymbol: string;
}) {
    const sides = [
        { label: 'Risk', figure: ticket.risk, tone: DOWN, sign: '-', missing: 'No stop set' },
        { label: 'Reward', figure: ticket.reward, tone: UP, sign: '+', missing: 'No target set' },
    ];

    return (
        <div className="relative flex overflow-hidden rounded-md" style={{ background: INSET }}>
            {sides.map(({ label, figure, tone, sign, missing }, index) => (
                <div
                    key={label}
                    className={`flex flex-1 flex-col gap-0.5 px-2.5 py-2 ${
                        index === 0 ? 'items-start' : 'items-end'
                    }`}
                >
                    <span className="text-[10.5px] text-slate-500">{label}</span>
                    {figure ? (
                        <>
                            <span className="flex items-baseline gap-1">
                                <span
                                    className="text-[15px] font-semibold tabular-nums tracking-tight"
                                    style={{ color: tone }}
                                >
                                    {sign}
                                    {cash(figure.usd)}
                                </span>
                                <span className="text-[10px] text-slate-600">
                                    {currencySymbol}
                                </span>
                            </span>
                            <span className="text-[10.5px] tabular-nums text-slate-500">
                                {signedPct(figure.pct)} of balance
                            </span>
                        </>
                    ) : (
                        <>
                            <span className="text-[15px] font-semibold tracking-tight text-slate-700">
                                &mdash;
                            </span>
                            <span className="text-[10.5px] text-slate-600">{missing}</span>
                        </>
                    )}
                </div>
            ))}
            {ticket.rr !== null && (
                <span
                    className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[10.5px] tabular-nums text-slate-400"
                    style={{ background: PANEL }}
                >
                    1:{ticket.rr.toFixed(2)}
                </span>
            )}
        </div>
    );
}

function Toggle({
    label,
    hint,
    checked,
    onChange,
}: {
    label: string;
    hint: string;
    checked: boolean;
    onChange: (next: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[11.5px] text-slate-400">{label}</span>
                <span className="text-[10.5px] leading-snug text-slate-600">{hint}</span>
            </div>
            <Switch
                checked={checked}
                onCheckedChange={onChange}
                className="mt-0.5 shrink-0 scale-[0.8] data-[state=checked]:bg-blue-500"
            />
        </div>
    );
}

function Section({
    title,
    open,
    onToggle,
    children,
}: {
    title: string;
    open: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-2.5">
            <button
                type="button"
                onClick={onToggle}
                className="flex items-center justify-between border-t pt-3 text-left outline-none"
                style={{ borderColor: HAIRLINE }}
            >
                <span className="text-[12.5px] font-medium text-slate-300">{title}</span>
                {open ? (
                    <ChevronUp className="h-3.5 w-3.5 text-slate-600" />
                ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-slate-600" />
                )}
            </button>
            {open && children}
        </div>
    );
}

const ORDER_TYPES = ['market', 'limit', 'stop'] as const;

const EXIT_UNITS = [
    { id: 'offset' as const, label: 'Ticks' },
    { id: 'price' as const, label: 'Price' },
];

const TIFS: { id: TimeInForce; label: string }[] = [
    { id: 'gtc', label: 'Good till cancelled' },
    { id: 'day', label: 'Day' },
    { id: 'ioc', label: 'Immediate or cancel' },
    { id: 'fok', label: 'Fill or kill' },
];

export interface OrderPanelProps {
    eventBus: TypedEventBus;
    spec: ContractSpec;
    symbol?: string;
    /** Send the order. Wire to `chart.executionEngine.placeOrder` */
    onPlaceOrder: (req: PlaceOrderRequest) => void;
    onClose?: () => void;
    /** Seed balance; kept current from `account:update` after mount */
    balance?: number;
    currencySymbol?: string;
    /** Viewport pixels, clamped. Only used the first open; after that the panel
     * reopens wherever it was last dragged. */
    initialPosition?: { x: number; y: number };
    /**
     * How the panel reads the chart's drawings, so it can build the ticket from
     * a long/short box and stay linked to it. Functions rather than values, so a
     * box dragged since it was selected reads as it now stands.
     */
    drawings?: {
        /** `() => chart.getSelectedDrawing()` */
        selected: () => ActiveDrawingTool | null;
        /** `(id) => chart.getDrawing(id)` - null once deleted */
        byId: (id: string) => ActiveDrawingTool | null;
        /** `(fn) => chart.onDrawingsChanged(fn)` */
        subscribe: (fn: () => void) => () => void;
    };
}

export function OrderPanel({
    eventBus,
    spec,
    symbol,
    onPlaceOrder,
    onClose,
    balance: initialBalance = 0,
    currencySymbol = 'USD',
    initialPosition = { x: 24, y: 96 },
    drawings,
}: OrderPanelProps) {
    const [quote, setQuote] = useState({ bid: 0, ask: 0, last: 0 });
    const quoteRef = useRef(quote);
    quoteRef.current = quote;
    const specRef = useRef(spec);
    specRef.current = spec;
    const [balance, setBalance] = useState(initialBalance);

    const [drawnSide, setDrawnSide] = useState<OrderSide | null>(null);
    const pressedDrawingRef = useRef<ActiveDrawingTool | null>(null);
    // the position drawing the ticket is following. it holds until the order is placed,
    // broken by hand, or the drawing is deleted
    const [linkedId, setLinkedId] = useState<string | null>(null);
    // held by ref so a host that builds this object inline doesnt re-subscribe
    // the link - and re-apply the drawing over the user's edits - every render
    const drawingsRef = useRef(drawings);
    drawingsRef.current = drawings;
    const hasDrawings = !!drawings;

    useEffect(() => {
        const readSelection = () => {
            const selected = drawingsRef.current?.selected();
            setDrawnSide(
                selected?.name === 'long'
                    ? 'long'
                    : selected?.name === 'short'
                      ? 'short'
                      : null,
            );
        };
        readSelection();

        const unsubs = [
            eventBus.on('playback:tick', ({ bid, ask, last }) => setQuote({ bid, ask, last })),
            eventBus.on('account:update', ({ balance: next }) => setBalance(next)),
            eventBus.on('drawing:selected', readSelection),
        ];
        return () => unsubs.forEach((fn) => fn());
    }, [eventBus, hasDrawings]);

    const last = rememberedTicket;
    const [side, setSide] = useState<OrderSide>(last?.side ?? 'long');
    const [type, setType] = useState<OrderType>(last?.type ?? 'market');
    const [tif, setTif] = useState<TimeInForce>(last?.tif ?? 'gtc');

    const [entry, setEntry] = useState<DualField>(last?.entry ?? dual('0'));
    const [amountMode, setAmountMode] = useState<AmountMode>(last?.amountMode ?? 'contracts');
    const [amount, setAmount] = useState(last?.amount ?? '1');

    const [tpOn, setTpOn] = useState(last?.tpOn ?? false);
    const [slOn, setSlOn] = useState(last?.slOn ?? false);
    const [tp, setTp] = useState<DualField>(last?.tp ?? dual('80'));
    const [sl, setSl] = useState<DualField>(last?.sl ?? dual('40'));

    const [exitsOpen, setExitsOpen] = useState(last?.exitsOpen ?? true);
    const [extrasOpen, setExtrasOpen] = useState(last?.extrasOpen ?? false);
    const [reduceOnly, setReduceOnly] = useState(last?.reduceOnly ?? false);
    const [keepOpen, setKeepOpen] = useState(last?.keepOpen ?? false);
    const [confirmFirst, setConfirmFirst] = useState(last?.confirmFirst ?? false);
    const [armed, setArmed] = useState(false);
    const armTimer = useRef<number | undefined>(undefined);

    useEffect(() => () => window.clearTimeout(armTimer.current), []);

    const ticketStateRef = useRef<RememberedTicket>(null as never);
    ticketStateRef.current = {
        side,
        type,
        tif,
        entry,
        amountMode,
        amount,
        tpOn,
        slOn,
        tp,
        sl,
        exitsOpen,
        extrasOpen,
        reduceOnly,
        confirmFirst,
        keepOpen,
    };
    useEffect(
        () => () => {
            rememberedTicket = ticketStateRef.current;
        },
        [],
    );

    const decimals = priceDecimals(spec);
    const tick = tickSizeOf(spec);
    const showPrice = (value: number) => fmt(value, decimals);
    const showQty = (value: number) => fmt(value, qtyDecimals(spec));
    const inputPrice = (value: number) => value.toFixed(decimals);

    // buy at ask, sell at bid, so a zero offset means the price
    // you would get right now rather than a mid
    const reference = useMemo(() => {
        const touch = side === 'long' ? quote.ask : quote.bid;
        return touch > 0 ? touch : quote.last;
    }, [side, quote]);

    const resolve = useCallback(
        (field: DualField, base: number, kind: 'tp' | 'sl' | 'entry') => {
            if (kind === 'entry') {
                return {
                    price:
                        field.fixed === 'price'
                            ? num(field.price)
                            : roundToTick(base + num(field.offset) * tick, spec),
                    offset:
                        field.fixed === 'offset'
                            ? num(field.offset)
                            : ticksBetween(base, num(field.price), spec),
                };
            }
            return {
                price:
                    field.fixed === 'price'
                        ? num(field.price)
                        : levelPrice(kind, base, num(field.offset), side, spec),
                offset:
                    field.fixed === 'offset'
                        ? num(field.offset)
                        : levelTicks(kind, base, num(field.price), side, spec),
            };
        },
        [side, spec, tick],
    );

    const entryResolved = resolve(entry, reference, 'entry');
    const entryPrice = type === 'market' ? reference : entryResolved.price;
    const tpResolved = resolve(tp, entryPrice, 'tp');
    const slResolved = resolve(sl, entryPrice, 'sl');

    const ticket: Ticket = useMemo(
        () =>
            deriveTicket({
                side,
                type,
                limitPrice: entryResolved.price,
                stopPrice: entryResolved.price,
                mark: quote.last,
                bid: quote.bid,
                ask: quote.ask,
                amountMode,
                amount: num(amount),
                tpEnabled: tpOn,
                tpTicks: tpResolved.offset,
                slEnabled: slOn,
                slTicks: slResolved.offset,
                balance,
                spec,
            }),
        [
            side,
            type,
            entryResolved.price,
            quote,
            amountMode,
            amount,
            tpOn,
            tpResolved.offset,
            slOn,
            slResolved.offset,
            balance,
            spec,
        ],
    );

    const problem = (field: 'amount' | 'entry' | 'tp' | 'sl') =>
        ticket.problems.find((entry) => entry.field === field);

    const changeAmountMode = (next: AmountMode) => {
        const carried = amountFromQty(next, ticket.qty, {
            entry: entryPrice,
            stopTicks: slOn ? Math.abs(slResolved.offset) : 0,
            balance,
            spec,
        });
        setAmountMode(next);
        if (carried > 0) setAmount(next === 'contracts' ? String(carried) : carried.toFixed(2));
    };

    // side and type both decide which side of the market is legal to rest on, so
    // either changing re-seeds the entry rather than carrying a price forward
    // that deriveTicket would only refuse
    const changeSide = (next: OrderSide) => {
        setSide(next);
        if (type !== 'market') setEntry(dual(restingOffset(next, type)));
    };

    const changeType = (next: OrderType) => {
        setType(next);
        if (next !== 'market') setEntry(dual(restingOffset(side, next)));
    };

    const flip = (setField: React.Dispatch<React.SetStateAction<DualField>>, resolved: { price: number; offset: number }) =>
        setField((field) =>
            field.fixed === 'offset'
                ? { fixed: 'price', price: inputPrice(resolved.price), offset: field.offset }
                : { fixed: 'offset', price: field.price, offset: String(resolved.offset) },
        );

    const applyDrawing = useCallback(
        (tool: ActiveDrawingTool) => {
            if (tool.name !== 'long' && tool.name !== 'short') return;
            const spec = specRef.current;
            const box = tool.state as PositionDrawing;
            const copied = ticketFromPosition(
                tool.name,
                {
                    entry: box.a.price,
                    upAmount: box.upAmount,
                    downAmount: box.downAmount,
                    qty: box.qty,
                },
                quoteRef.current.last,
                spec,
            );

            setSide(copied.side);
            setType(copied.type);
            if (copied.type !== 'market') {
                setEntry({
                    fixed: 'price',
                    price: copied.entry.toFixed(priceDecimals(spec)),
                    offset: '0',
                });
            }
            setAmountMode('contracts');
            setAmount(String(copied.qty));
            setTpOn(true);
            setSlOn(true);
            setTp({ fixed: 'price', price: copied.target.toFixed(priceDecimals(spec)), offset: '0' });
            setSl({ fixed: 'price', price: copied.stop.toFixed(priceDecimals(spec)), offset: '0' });
            setExitsOpen(true);
        },
        [],
    );

    const linkToDrawing = () => {
        // falls back to what was selected when teh press landed, so anything
        // clearing the selection between press and click cant strand it
        const selected = drawings?.selected() ?? pressedDrawingRef.current;
        if (!selected || (selected.name !== 'long' && selected.name !== 'short')) return;
        applyDrawing(selected);
        setLinkedId(selected.id);
    };

    useEffect(() => {
        return eventBus.on('trading:ticket-requested', ({ drawingId, requestId }) => {
            if (requestId === consumedTicketRequest) return;
            consumedTicketRequest = requestId;
            if (!drawingId) return;

            const tool = drawingsRef.current?.byId(drawingId);
            if (!tool || (tool.name !== 'long' && tool.name !== 'short')) return;
            applyDrawing(tool);
            setLinkedId(drawingId);
        });
    }, [eventBus, applyDrawing]);

    useEffect(() => {
        const access = drawingsRef.current;
        if (!linkedId || !access) return;

        const follow = () => {
            const tool = access.byId(linkedId);
            if (!tool) {
                setLinkedId(null);
                return;
            }
            applyDrawing(tool);
        };
        follow();
        return access.subscribe(follow);
    }, [linkedId, hasDrawings, applyDrawing]);

    const submit = () => {
        if (!ticket.ok) return;

        // the second press has to arrive while the button is still asking, so a
        // stray double click can't sail through a ticket meant to be checked
        if (confirmFirst && !armed) {
            setArmed(true);
            window.clearTimeout(armTimer.current);
            armTimer.current = window.setTimeout(() => setArmed(false), 4000);
            return;
        }
        window.clearTimeout(armTimer.current);
        setArmed(false);

        const level = (price: number) => [
            { id: nanoid(8), price, qty: ticket.qty, triggered: false, triggeredAt: 0 },
        ];
        onPlaceOrder({
            side,
            type,
            qty: ticket.qty,
            symbol,
            tif,
            ...(reduceOnly ? { reduceOnly: true } : {}),
            ...(type === 'limit' ? { limitPrice: ticket.entry } : {}),
            ...(type === 'stop' ? { stopPrice: ticket.entry } : {}),
            ...(ticket.tpPrice !== null ? { bracketTp: level(ticket.tpPrice) } : {}),
            ...(ticket.slPrice !== null ? { bracketSl: level(ticket.slPrice) } : {}),
        });

        // the trade has been taken; leaving the ticket wired to the box would
        // let a later nudge of it rewrite an order that is already live
        setLinkedId(null);

        // otherwise the preview reappears - unlinked, so no longer suppressed -
        // on top of the position it just became
        if (!keepOpen) onClose?.();
    };

    const buying = side === 'long';
    const accent = buying ? UP : DOWN;

    useEffect(() => {
        const clear = () => eventBus.emit('trading:preview', { lines: [], symbol });

        if (linkedId || ticket.qty <= 0) {
            clear();
            return clear;
        }

        const ghost = (over: Partial<TradeLine>): TradeLine => ({
            price: 0,
            kind: 'custom',
            preview: true,
            movable: true,
            qty: ticket.qty,
            ...over,
        });

        // the renderer parses this back out to colour the segment, so it has to
        // stay machine readable: a sign, a dollar mark, no thousands separators,
        // whatever, or Number returns NaN and a $1,200 target renders grey
        const money = (value: number) => `${value < 0 ? '-' : '+'}$${Math.abs(value).toFixed(2)}`;

        const lines: TradeLine[] = [
            // wouldnt really make sense to give a market order an entry line.
            // itd look ugly
            ...(type === 'market'
                ? []
                : [
                      ghost({
                          id: 'preview-entry',
                          kind: type === 'limit' ? 'limit' : 'stop',
                          side,
                          price: ticket.entry,
                          label: `${buying ? 'Buy' : 'Sell'} ${
                              type === 'limit' ? 'Limit' : 'Stop'
                          }`,
                          onMove: (price) =>
                              setEntry({ fixed: 'price', price: inputPrice(price), offset: '0' }),
                          onClose: () => onClose?.(),
                      }),
                  ]),
            ...(ticket.tpPrice !== null
                ? [
                      ghost({
                          id: 'preview-tp',
                          kind: 'tp',
                          price: ticket.tpPrice,
                          label: `TP ${money(ticket.reward?.usd ?? 0)}`,
                          onMove: (price) =>
                              setTp({ fixed: 'price', price: inputPrice(price), offset: '0' }),
                          onClose: () => setTpOn(false),
                      }),
                  ]
                : []),
            ...(ticket.slPrice !== null
                ? [
                      ghost({
                          id: 'preview-sl',
                          kind: 'sl',
                          price: ticket.slPrice,
                          // negative - the renderer colours by that sign
                          label: `SL ${money(-(ticket.risk?.usd ?? 0))}`,
                          onMove: (price) =>
                              setSl({ fixed: 'price', price: inputPrice(price), offset: '0' }),
                          onClose: () => setSlOn(false),
                      }),
                  ]
                : []),
        ];

        eventBus.emit('trading:preview', { lines, symbol });
        return clear;
    }, [
        eventBus,
        symbol,
        linkedId,
        side,
        type,
        accent,
        buying,
        ticket.entry,
        ticket.qty,
        ticket.tpPrice,
        ticket.slPrice,
        ticket.reward?.usd,
        ticket.risk?.usd,
    ]);

    const panelRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState(() => rememberedPosition ?? initialPosition);
    const dragRef = useRef<{ dx: number; dy: number } | null>(null);

    const settle = useCallback((next: { x: number; y: number }) => {
        const height = panelRef.current?.offsetHeight ?? 0;
        const clamped = { x: clampLeft(next.x), y: clampTop(next.y, height) };
        rememberedPosition = clamped;
        setPosition(clamped);
    }, []);

    // re-clamp whenever the panel's own height changes - opening exits or a
    // validation line can push the bottom past the window edge
    useLayoutEffect(() => {
        const element = panelRef.current;
        if (!element) return;

        const check = () => {
            const height = element.offsetHeight;
            setPosition((current) => {
                const clamped = { x: clampLeft(current.x), y: clampTop(current.y, height) };
                if (clamped.x === current.x && clamped.y === current.y) return current;
                rememberedPosition = clamped;
                return clamped;
            });
        };
        check();

        const observer = new ResizeObserver(check);
        observer.observe(element);
        window.addEventListener('resize', check);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', check);
        };
    }, []);

    return (
        <div
            ref={panelRef}
            className="fixed z-[200] flex w-[370px] min-h-0 select-none flex-col overflow-hidden rounded-xl border shadow-2xl"
            style={{
                left: position.x,
                top: position.y,
                background: PANEL,
                borderColor: EDGE,
                maxHeight: `calc(100vh - ${position.y + VIEWPORT_PADDING}px)`,
            }}
        >
            <div
                className="flex shrink-0 cursor-grab items-center gap-2 px-3 py-3 active:cursor-grabbing"
                onPointerDown={(event) => {
                    dragRef.current = {
                        dx: event.clientX - position.x,
                        dy: event.clientY - position.y,
                    };
                    (event.target as HTMLElement).setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                    const origin = dragRef.current;
                    if (!origin) return;
                    settle({ x: event.clientX - origin.dx, y: event.clientY - origin.dy });
                }}
                onPointerUp={() => {
                    dragRef.current = null;
                }}
            >
                <img src='/icon-star.ico' alt='' className='w-5' />
                <span className="text-[13px] font-medium tracking-tight text-slate-100 ">
                    {symbol || 'Order'}
                </span>
                {onClose && (
                    <button
                        type="button"
                        onClick={onClose}
                        className="ml-auto shrink-0 text-slate-600 outline-none transition-colors hover:text-slate-300"
                    >
                        <X className="h-4 w-4" />
                    </button>
                )}
            </div>

            <div className="flex shrink-0 flex-col gap-3 px-3 pb-3">
                <div className="relative flex overflow-hidden rounded-xl" style={{ background: WELL }}>
                    {(['short', 'long'] as const).map((option) => {
                        const on = side === option;
                        const sell = option === 'short';
                        const colour = sell ? DOWN : UP;
                        return (
                            <button
                                key={option}
                                type="button"
                                onClick={() => changeSide(option)}
                                className={`flex flex-1 flex-col gap-0.5 px-3 py-2 outline-none transition-colors ${
                                    sell ? 'items-start rounded-l-xl' : 'items-end rounded-r-xl'
                                }`}
                                style={{
                                    background: on ? `${colour}1f` : 'transparent',
                                    boxShadow: on ? `inset 0 0 0 1px ${colour}59` : undefined,
                                }}
                            >
                                <span
                                    className="text-[11.5px] font-medium"
                                    style={{ color: on ? colour : '#64748b' }}
                                >
                                    {sell ? 'Sell' : 'Buy'}
                                </span>
                                <span
                                    className="text-[17px] font-semibold tracking-tight"
                                    style={{ color: on ? colour : '#94a3b8' }}
                                >
                                    {showPrice(sell ? quote.bid : quote.ask)}
                                </span>
                            </button>
                        );
                    })}
                    <span
                        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-4 rounded px-1.5 py-0.5 text-[10.5px] tabular-nums text-slate-400"
                        style={{ background: PANEL }}
                    >
                        {ticket.spread.usd}
                    </span>
                </div>

                {linkedId ? (
                    <div
                        className="flex items-center gap-1.5 rounded-md border py-1.5 pl-2.5 pr-1.5 text-[11.5px]"
                        style={{ borderColor: `${accent}59`, color: accent }}
                    >
                        <Link2 className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">Following the {side} drawing</span>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    onClick={() => setLinkedId(null)}
                                    className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-slate-500 outline-none transition-colors hover:bg-white/5 hover:text-slate-300"
                                >
                                    <Unlink className="h-3 w-3" />
                                    Unlink
                                </button>
                            </TooltipTrigger>
                            <TooltipContent className='bg-background border border-border z-[210]'>
                                Stop following it
                            </TooltipContent>
                        </Tooltip>
                    </div>
                ) : (
                    drawnSide && (
                        <button
                            type="button"
                            onPointerDown={() => {
                                pressedDrawingRef.current = drawings?.selected() ?? null;
                            }}
                            onClick={linkToDrawing}
                            className="flex items-center justify-center gap-1.5 rounded-md border border-dashed py-1.5 text-[11.5px] outline-none transition-[filter,transform] hover:brightness-125 active:scale-[0.99]"
                            style={{
                                borderColor: `${drawnSide === 'long' ? UP : DOWN}66`,
                                color: drawnSide === 'long' ? UP : DOWN,
                            }}
                        >
                            <Link2 className="h-3 w-3" />
                            Follow the selected {drawnSide} drawing
                        </button>
                    )
                )}

                <div className="relative flex border-b" style={{ borderColor: HAIRLINE }}>
                    {ORDER_TYPES.map((option) => {
                        const on = type === option;
                        return (
                            <button
                                key={option}
                                type="button"
                                onClick={() => changeType(option)}
                                className={`flex-1 pb-2 text-[12.5px] capitalize outline-none transition-colors ${
                                    on ? 'text-slate-100' : 'text-slate-500 hover:text-slate-300'
                                }`}
                            >
                                {option}
                            </button>
                        );
                    })}
                    <span
                        aria-hidden
                        className="absolute bottom-[-1px] h-[2px] rounded-full motion-safe:transition-[left] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]"
                        style={{
                            background: accent,
                            width: `${100 / ORDER_TYPES.length}%`,
                            left: `${
                                (Math.max(0, ORDER_TYPES.indexOf(type as (typeof ORDER_TYPES)[number])) *
                                    100) /
                                ORDER_TYPES.length
                            }%`,
                        }}
                    />
                </div>

            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
                {type !== 'market' && (
                    <div className="flex flex-col gap-1.5">
                        <span className="text-[11.5px] text-slate-500">
                            {entry.fixed === 'offset'
                                ? `Ticks from ${buying ? 'ask' : 'bid'}`
                                : 'Entry price'}
                        </span>
                        <SwapField
                            value={entry.fixed === 'price' ? entry.price : entry.offset}
                            onChange={(next) =>
                                setEntry((field) => ({
                                    ...field,
                                    [field.fixed === 'price' ? 'price' : 'offset']: next,
                                }))
                            }
                            readout={
                                entry.fixed === 'price'
                                    ? String(entryResolved.offset)
                                    : showPrice(entryResolved.price)
                            }
                            readoutUnit={entry.fixed === 'price' ? 'ticks' : 'price'}
                            onSwap={() => flip(setEntry, entryResolved)}
                            invalid={!!problem('entry')}
                        />
                    </div>
                )}

                <div className="flex flex-col gap-1.5">
                    <ModeLabel
                        value={amountMode}
                        options={AMOUNT_MODES}
                        onChange={changeAmountMode}
                    />
                    <SwapField
                        value={amount}
                        onChange={setAmount}
                        readout={
                            amountMode === 'contracts'
                                ? fmt(ticket.contractValue, 0)
                                : String(ticket.qty)
                        }
                        readoutUnit={amountMode === 'contracts' ? currencySymbol : 'contracts'}
                        onSwap={() =>
                            changeAmountMode(amountMode === 'contracts' ? 'value' : 'contracts')
                        }
                        invalid={!!problem('amount')}
                    />
                </div>

                <Section title="Exits" open={exitsOpen} onToggle={() => setExitsOpen((o) => !o)}>
                    {(
                        [
                            ['tp', 'Take profit', tpOn, setTpOn, tp, setTp, tpResolved],
                            ['sl', 'Stop loss', slOn, setSlOn, sl, setSl, slResolved],
                        ] as const
                    ).map(([kind, label, on, setOn, field, setField, resolved]) => (
                        <div key={kind} className="flex flex-col gap-1.5">
                            <div className="flex items-center justify-between gap-2">
                                <ModeLabel
                                    prefix={label}
                                    value={field.fixed}
                                    options={EXIT_UNITS}
                                    onChange={(next) =>
                                        setField((current) =>
                                            current.fixed === next
                                                ? current
                                                : next === 'price'
                                                  ? {
                                                        fixed: 'price',
                                                        price: inputPrice(resolved.price),
                                                        offset: current.offset,
                                                    }
                                                  : {
                                                        fixed: 'offset',
                                                        price: current.price,
                                                        offset: String(resolved.offset),
                                                    },
                                        )
                                    }
                                />
                                <Switch
                                    checked={on}
                                    onCheckedChange={setOn}
                                    className="scale-[0.8] data-[state=checked]:bg-blue-500"
                                />
                            </div>
                            <SwapField
                                disabled={!on}
                                onActivate={() => setOn(true)}
                                value={field.fixed === 'price' ? field.price : field.offset}
                                onChange={(next) =>
                                    setField((current) => ({
                                        ...current,
                                        [current.fixed === 'price' ? 'price' : 'offset']: next,
                                    }))
                                }
                                readout={
                                    field.fixed === 'price'
                                        ? String(resolved.offset)
                                        : showPrice(resolved.price)
                                }
                                readoutUnit={field.fixed === 'price' ? 'ticks' : 'price'}
                                onSwap={() => flip(setField, resolved)}
                                invalid={!!problem(kind)}
                            />
                        </div>
                    ))}

                </Section>

                <Section
                    title="Extra settings"
                    open={extrasOpen}
                    onToggle={() => setExtrasOpen((o) => !o)}
                >
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[11.5px] text-slate-500">Time in force</span>
                        <ModeLabel
                            value={tif}
                            options={TIFS}
                            onChange={(next) => setTif(next)}
                        />
                    </div>

                    <Toggle
                        label="Reduce only"
                        hint="Never opens or grows a position - only closes one"
                        checked={reduceOnly}
                        onChange={setReduceOnly}
                    />
                    <Toggle
                        label="Confirm before placing"
                        hint="The button asks a second time before the order goes"
                        checked={confirmFirst}
                        onChange={(next) => {
                            setConfirmFirst(next);
                            setArmed(false);
                        }}
                    />
                    <Toggle
                        label="Keep the ticket open"
                        hint="Stays up after an order goes, for placing several in a row"
                        checked={keepOpen}
                        onChange={setKeepOpen}
                    />
                </Section>
            </div>

            <div
                className="flex shrink-0 flex-col gap-2 border-t px-3 pb-3 pt-3"
                style={{ borderColor: HAIRLINE }}
            >
                <RiskReward ticket={ticket} currencySymbol={currencySymbol} />

                <Figures
                    rows={[
                        {
                            label: 'Position value',
                            value: fmt(ticket.contractValue),
                            unit: currencySymbol,
                        },
                        {
                            label: 'Per tick',
                            value: cash(ticket.tickValue * Math.max(0, ticket.qty)),
                            unit: currencySymbol,
                        },
                        {
                            label: 'Spread cost',
                            value: cash(ticket.spread.usd * Math.max(0, ticket.qty)),
                            unit: currencySymbol,
                        },
                    ]}
                />

                {ticket.problems.length > 0 && (
                    <p className="text-[11.5px] leading-relaxed text-amber-500/90">
                        {ticket.problems[0].message}
                    </p>
                )}

                <Button
                    type="button"
                    disabled={!ticket.ok}
                    onClick={submit}
                    className="h-[52px] w-full flex-col gap-0.5 rounded-lg border-0 text-white shadow-none transition-[transform,filter] duration-100 hover:brightness-110 active:scale-[0.985] active:brightness-95 disabled:opacity-30"
                    style={{ background: accent }}
                >
                    <span className="text-[14px] font-semibold leading-none">
                        {armed
                            ? 'Press again to confirm'
                            : `${buying ? 'Buy' : 'Sell'} ${showQty(ticket.qty)} ${symbol ?? ''}`}
                    </span>
                    <span className="text-[11px] font-normal leading-none text-white/75">
                        {armed
                            ? `${buying ? 'Buy' : 'Sell'} ${showQty(ticket.qty)} ${symbol ?? ''} ${
                                  type === 'market' ? 'at market' : `@ ${showPrice(ticket.entry)}`
                              }`
                            : type === 'market'
                              ? 'at market'
                              : `${type} @ ${showPrice(ticket.entry)}`}
                    </span>
                </Button>
            </div>
        </div>
    );
}
