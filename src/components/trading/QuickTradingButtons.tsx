'use client';

import React, { useCallback, useState } from 'react';
import type { TypedEventBus } from '../../core/TypedEventBus';
import { Button } from '../ui/button';
import { Minus, Plus } from 'lucide-react';
import { Input } from '../ui/input';
import { Separator } from '../ui/separator';

interface QuickTradingButtonsProps {
    eventBus: TypedEventBus;
}

export function QuickTradingButtons({ eventBus }: QuickTradingButtonsProps) {
    const [amount, setAmount] = useState('1');

    const roundTo = (num: number, decimals: number) =>
        Math.round(num * 10 ** decimals) / 10 ** decimals;

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        let value = e.target.value;

        const numericValue = parseFloat(value);
        if (!isNaN(numericValue)) {
            value = Math.round(numericValue).toString();
        }

        setAmount(value);
    };

    const buyMarket = useCallback(() => {
        eventBus.emit('trading:buy-market', { amount: parseFloat(amount) });
    }, [amount]);

    const sellMarket = useCallback(() => {
        eventBus.emit('trading:sell-market', { amount: parseFloat(amount) });
    }, [amount]);

    const flatten = useCallback(() => {
        eventBus.emit('trading:flatten', undefined);
    }, [eventBus]);

    return (
        <div className="flex gap-2 justify-center md:justify-self-end items-center order-2 md:order-3">
            <div className="flex items-center gap-1 rounded-md flex-wrap justify-center">
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 hover:bg-slate-800 text-slate-300 hover:text-white"
                    onClick={() => {
                        setAmount((prev) =>
                            roundTo(Math.max(0, parseFloat(prev) - 1), 0).toString(),
                        );
                    }}
                >
                    <Minus className="h-4 w-4" />
                </Button>
                <Input
                    value={amount}
                    onChange={handleInputChange}
                    className="w-20 h-9 bg-transparent border-none text-center text-sm text-slate-200 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder="Amount"
                />
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 hover:bg-slate-800 text-slate-300 hover:text-white"
                    onClick={() => {
                        setAmount((prev) => roundTo(parseFloat(prev) + 1, 0).toString());
                    }}
                >
                    <Plus className="h-4 w-4" />
                </Button>
                <Separator orientation="vertical" className="h-4 bg-slate-700" />
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 px-3 text-xs  text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600"
                    onClick={() => {
                        buyMarket();
                    }}
                >
                    Buy
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 px-3 text-xs hover:bg-rose-500/10 text-rose-600 hover:text-rose-600"
                    onClick={() => {
                        sellMarket();
                    }}
                >
                    Sell
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 px-3 text-xs text-slate-300 hover:bg-muted hover:text-white"
                    onClick={flatten}
                >
                    Flatten
                </Button>
            </div>
        </div>
    );
}
