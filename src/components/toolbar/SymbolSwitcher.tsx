'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TypedEventBus } from '../../core';
import { ChevronDown, Loader2, Search } from 'lucide-react';
import { nanoid } from 'nanoid';
import { SymbolInfo } from '../../interfaces/IDataAdapter';
import { cn } from '../../lib/utils';
import { SymbolIcon } from '../chart/symbol-icon';
import { describeDataError } from '../chart/chart-status-overlay';

interface SymbolSwitcherProps {
    eventBus: TypedEventBus;
    symbol: string;
    onSymbolChange: (symbol: string) => void;
}

type LoadedSymbol = SymbolInfo & { id: string };

const PAGE_SIZE = 150;
// dont flash a spinner for a search that resolves quickly
const LOADER_DELAY_MS = 250;

export default function SymbolSwitcher({ eventBus, symbol, onSymbolChange }: SymbolSwitcherProps) {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [showLoader, setShowLoader] = useState(false);
    const [symbols, setSymbols] = useState<LoadedSymbol[]>([]);
    const [query, setQuery] = useState('');
    const [cursor, setCursor] = useState<string | undefined>(undefined);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<{ code: string; message: string } | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const popoverRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    // only newest request should render, stale answers are dropped
    const requestIdRef = useRef<string | null>(null);
    // whether the in flight request appends a page or replaces the list
    const appendingRef = useRef(false);
    const debounceRef = useRef(0);

    const toggle = () => setOpen((prev) => !prev);

    const runSearch = useCallback(
        (q: string, nextCursor?: string) => {
            const requestId = nanoid();
            requestIdRef.current = requestId;
            appendingRef.current = !!nextCursor;

            if (nextCursor) setLoadingMore(true);
            else setLoading(true);
            setError(null);

            eventBus.emit('data:search-symbols', {
                requestId,
                request: { query: q, limit: PAGE_SIZE, cursor: nextCursor },
            });
        },
        [eventBus],
    );

    useEffect(() => {
        const unsubs = [
            eventBus.on('data:search-symbols-response', (payload) => {
                if (payload.requestId !== requestIdRef.current) return;
                debounceRef.current = payload.debounceMs;

                const rows = payload.symbols.map((s) => ({ ...s, id: nanoid() }));
                setSymbols((prev) => (appendingRef.current ? [...prev, ...rows] : rows));
                setHasMore(payload.hasMore);
                setCursor(payload.cursor);
                setLoading(false);
                setLoadingMore(false);
            }),
            eventBus.on('data:search-symbols-error', (payload) => {
                if (payload.requestId !== requestIdRef.current) return;
                setError({ code: payload.code, message: payload.message });
                setLoading(false);
                setLoadingMore(false);
            }),
            eventBus.on('chart:open-symbol-select', () => {
                toggle();
            }),
        ];
        return () => unsubs.forEach((fn) => fn());
    }, [eventBus]);

    useEffect(() => {
        if (!open) {
            const abandoned = requestIdRef.current;
            requestIdRef.current = null;
            if (abandoned) eventBus.emit('data:search-symbols-cancel', { requestId: abandoned });
            // reset here rather than on open, so the next open renders with an
            // empty query and never schedules a search for the old one
            setQuery('');
            setError(null);
            return;
        }
        const t = setTimeout(() => searchRef.current?.focus(), 40);
        const onDown = (e: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            clearTimeout(t);
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open, eventBus]);

    useEffect(() => {
        if (!open) return;
        if (!debounceRef.current) {
            runSearch(query);
            return;
        }
        const t = setTimeout(() => runSearch(query), debounceRef.current);
        return () => clearTimeout(t);
    }, [open, query, runSearch]);

    useEffect(() => {
        if (!loading) {
            setShowLoader(false);
            return;
        }
        const t = setTimeout(() => setShowLoader(true), LOADER_DELAY_MS);
        return () => clearTimeout(t);
    }, [loading]);

    const pick = (s: string) => {
        onSymbolChange(s);
        setOpen(false);
    };

    const toggleExpanded = (id: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const errorInfo = error ? describeDataError(error.code, error.message) : null;

    return (
        <div className="relative" ref={popoverRef}>
            <button
                onClick={toggle}
                className={cn(
                    'relative group flex items-center h-7 pl-2.5 pr-2 rounded-md w-24 overflow-hidden',
                    'border transition-colors duration-150 select-none',
                    open
                        ? 'border-border bg-muted/30'
                        : 'border-transparent hover:bg-[#1a1d23]/30 hover:border-border',
                )}
            >
                <div
                    className="relative flex-1 min-w-0 overflow-hidden"
                    style={{
                        WebkitMaskImage:
                            'linear-gradient(to right, black calc(100% - 1.25rem), transparent)',
                        maskImage:
                            'linear-gradient(to right, black calc(100% - 1.25rem), transparent)',
                    }}
                >
                    <span className="block whitespace-nowrap text-[12px] font-semibold tracking-tight text-slate-100 uppercase leading-none">
                        {symbol}
                    </span>
                </div>

                <ChevronDown
                    size={10}
                    className={cn(
                        'shrink-0 ml-1 opacity-50 text-slate-400 transition-transform duration-150',
                        open && 'rotate-180',
                    )}
                />
            </button>

            {open && (
                <div className="absolute left-0 top-full mt-1.5 z-50 flex flex-col w-[35rem] max-h-[26rem] rounded-lg border border-[#1e2128] bg-[#16181d] shadow-2xl overflow-hidden">
                    <div className="flex items-center gap-2.5 px-3 h-11 border-b border-[#1e2128] shrink-0">
                        <Search size={14} className="text-slate-600 shrink-0" />
                        <input
                            ref={searchRef}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search symbol, name or exchange…"
                            className="w-full h-full bg-transparent outline-none text-[13px] text-slate-200 placeholder:text-slate-600"
                        />
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto py-1">
                        {errorInfo ? (
                            <div className="flex flex-col items-center justify-center py-14 gap-1.5 px-8 text-center">
                                <span
                                    className={cn(
                                        errorInfo.tier === 'error'
                                            ? 'text-rose-400/80'
                                            : 'text-slate-500',
                                    )}
                                >
                                    {errorInfo.icon}
                                </span>
                                <div className="text-[13px] text-slate-300">{errorInfo.title}</div>
                                <div className="text-[11px] text-slate-500 leading-relaxed">
                                    {errorInfo.body}
                                </div>
                                {errorInfo.canRetry && (
                                    <button
                                        onClick={() => runSearch(query)}
                                        className="mt-1.5 h-6 px-2.5 rounded border border-[#1e2128] bg-[#0e1014] text-[11px] text-slate-300 hover:border-[#08b3de]/40 hover:text-white transition-colors"
                                    >
                                        Try again
                                    </button>
                                )}
                            </div>
                        ) : showLoader && !symbols.length ? (
                            <div className="flex items-center justify-center py-16 text-slate-600">
                                <Loader2 size={18} className="animate-spin" />
                            </div>
                        ) : !symbols.length && !loading ? (
                            <div className="flex flex-col items-center justify-center py-16 gap-1 text-slate-600">
                                <div className="text-[13px] text-slate-500">No symbols found</div>
                                {query && (
                                    <div className="text-[11px]">
                                        Nothing matches "{query.trim()}"
                                    </div>
                                )}
                            </div>
                        ) : (
                            <>
                                {symbols.map((s) => (
                                    <SymbolRow
                                        key={s.id}
                                        sym={s}
                                        active={s.symbol === symbol}
                                        expanded={expanded.has(s.id)}
                                        onPick={pick}
                                        onToggle={() => toggleExpanded(s.id)}
                                    />
                                ))}

                                {hasMore && (
                                    <button
                                        onClick={() => runSearch(query, cursor)}
                                        disabled={loadingMore}
                                        className="w-full h-8 flex items-center justify-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-300 hover:bg-[#1a1d23] transition-colors disabled:hover:bg-transparent"
                                    >
                                        {loadingMore ? (
                                            <Loader2 size={12} className="animate-spin" />
                                        ) : (
                                            'Load more'
                                        )}
                                    </button>
                                )}
                            </>
                        )}
                    </div>

                    <div className="flex items-center gap-2 h-7 px-3 border-t border-[#1e2128] shrink-0">
                        <span className="text-[10px] text-slate-600 tabular-nums">
                            {symbols.length}
                            {hasMore ? '+' : ''} {symbols.length === 1 ? 'symbol' : 'symbols'}
                        </span>
                        {(loading || loadingMore) && (
                            <Loader2 size={10} className="animate-spin text-slate-600" />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function SymbolRow({
    sym,
    active,
    expanded,
    onPick,
    onToggle,
}: {
    sym: SymbolInfo;
    active: boolean;
    expanded: boolean;
    onPick: (s: string) => void;
    onToggle: () => void;
}) {
    const hasSubs = !!sym.subsymbols?.length;

    return (
        <>
            <button
                onClick={() => onPick(sym.symbol)}
                className={cn(
                    'group w-full flex items-center gap-3 pl-3 pr-1.5 h-9 text-left transition-colors duration-200 hover:duration-0',
                    active ? 'bg-[#1a1d23]' : 'hover:bg-[#1a1d23]',
                )}
            >
                {active ? (
                    <div className="w-1 h-1 rounded-full bg-[#08b3de] shrink-0" />
                ) : (
                    <div className="w-1 shrink-0" />
                )}

                {sym?.icon && (
                    <SymbolIcon icon={sym.icon} size={24} fallback={sym.symbol} />
                )}

                <span
                    className={cn(
                        'text-[12px] font-semibold uppercase tracking-tight w-24 shrink-0 truncate',
                        active ? 'text-white' : 'text-slate-300',
                    )}
                >
                    {sym.symbol}
                </span>

                <span className="text-[11px] text-slate-500 truncate flex-1 group-hover:text-slate-400">
                    {sym.description ?? sym?.longName ?? ''}
                </span>

                {sym.type && (
                    <span className="text-[9px] font-medium uppercase tracking-wider text-slate-500 px-1.5 py-0.5 rounded border border-[#1e2128] bg-[#0e1014] shrink-0">
                        {sym.type}
                    </span>
                )}

                <span className="text-[11px] text-slate-600 w-14 shrink-0 truncate">
                    {sym.exchange ?? ''}
                </span>

                {hasSubs ? (
                    <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggle();
                        }}
                        className="w-6 h-6 flex items-center justify-center rounded text-slate-600 hover:text-slate-300 hover:bg-[#1e2128] shrink-0"
                    >
                        <ChevronDown
                            size={13}
                            className={cn(
                                'transition-transform duration-150',
                                expanded && 'rotate-180',
                            )}
                        />
                    </span>
                ) : (
                    <span className="w-6 shrink-0" />
                )}
            </button>

            {hasSubs &&
                expanded &&
                sym.subsymbols!.map((sub) => (
                    <button
                        key={sub.symbol}
                        onClick={() => onPick(sub.symbol)}
                        className="group w-full flex items-center gap-3 pl-3 pr-1.5 h-8 text-left bg-[#121419] hover:bg-[#1a1d23] transition-colors"
                    >
                        <div className="w-1 shrink-0" />
                        <span className="w-24 shrink-0 flex items-center gap-2">
                            <span className="w-3 h-px bg-[#272b33] shrink-0" />
                            <span className="text-[11px] font-medium uppercase tracking-tight text-slate-400 truncate group-hover:text-slate-200">
                                {sub.symbol}
                            </span>
                        </span>
                        <span className="text-[11px] text-slate-600 truncate flex-1 group-hover:text-slate-500">
                            {sub.longName ?? sub.description ?? ''}
                        </span>
                        {sub.type && (
                            <span className="text-[9px] font-medium uppercase tracking-wider text-slate-600 px-1.5 py-0.5 rounded border border-[#1e2128] shrink-0">
                                {sub.type}
                            </span>
                        )}
                        <span className="text-[11px] text-slate-600 w-14 shrink-0 truncate">
                            {sub.exchange ?? ''}
                        </span>
                        <span className="w-6 shrink-0" />
                    </button>
                ))}
        </>
    );
}
