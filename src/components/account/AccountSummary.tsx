'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { TypedEventBus } from '../../core/TypedEventBus';
import type { AccountSnapshot } from '../../interfaces/IAccountAdapter';

interface AccountSummaryProps {
    eventBus: TypedEventBus;
    currencySymbol?: string;
}

function fmt(n: number, dec = 2): string {
    return n.toLocaleString('en-US', {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec,
    });
}

function PnlLabel({ value, label }: { value: number; label: string }) {
    const color = value > 0 ? 'text-emerald-400' : value < 0 ? 'text-red-400' : 'text-slate-400';
    const prefix = value > 0 ? '+' : '';
    return (
        <div className="flex flex-col items-start leading-none">
            <span className="text-[9px] text-slate-500 uppercase tracking-wide">{label}</span>
            <span className={`text-[11px] font-mono tabular-nums ${color}`}>
                {prefix}
                {fmt(value)}
            </span>
        </div>
    );
}

export function AccountSummary({ eventBus, currencySymbol = '$' }: AccountSummaryProps) {
    const [snap, setSnap] = useState<AccountSnapshot | null>(null);
    const [spread, setSpread] = useState(0);
    const spreadRef = useRef(0);

    useEffect(() => {
        const unsubs = [
            eventBus.on('account:update', setSnap),
            eventBus.on('playback:tick', (data) => {
                spreadRef.current = data.spread;
            }),
        ];
        return () => unsubs.forEach((fn) => fn());
    }, [eventBus]);

    useEffect(() => {
        const id = setInterval(() => setSpread(spreadRef.current), 250);
        return () => clearInterval(id);
    }, []);

    if (!snap) return null;

    return (
        <div className="flex items-center gap-3 text-xs select-none">
            <div className="flex flex-col items-start leading-none">
                <span className="text-[9px] text-slate-500 uppercase tracking-wide">Balance</span>
                <span className="text-[11px] font-mono tabular-nums text-slate-200">
                    {currencySymbol}
                    {fmt(snap.balance)}
                </span>
            </div>

            <div className="h-4 w-px bg-slate-700" />

            <div className="flex flex-col items-start leading-none">
                <span className="text-[9px] text-slate-500 uppercase tracking-wide">Equity</span>
                <span className="text-[11px] font-mono tabular-nums text-slate-200">
                    {currencySymbol}
                    {fmt(snap.equity)}
                </span>
            </div>

            <div className="h-4 w-px bg-slate-700" />

            <PnlLabel value={snap.unrealizedPnl} label="Open P&L" />

            <div className="h-4 w-px bg-slate-700" />

            <PnlLabel value={snap.realizedPnl} label="Realized" />

            <div className="h-4 w-px bg-slate-700" />

            <div className="flex flex-col items-start leading-none">
                <span className="text-[9px] text-slate-500 uppercase tracking-wide">Spread</span>
                <span className="text-[11px] font-mono tabular-nums text-slate-200">
                    {currencySymbol}
                    {fmt(spread)}
                </span>
            </div>
        </div>
    );
}
