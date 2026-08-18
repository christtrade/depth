import { useEffect, useState } from 'react';
import type { TypedEventBus } from '../../core/TypedEventBus';
import type { ChartType, PriceHistory, ViewBounds, OhlcvBarMs } from '../../lib/types';
import type { DataLevel } from '../../interfaces/IDataAdapter';
import type { LiveTransformer } from '../../interfaces/ICoordinateTransformer';
import type { FootprintBar } from '../../lib/types/footprint';
import type { ChartSettings } from '../../lib/types/chart-settings';
import { cn } from '../../lib/utils';

type CandleCache = Map<
    bigint,
    { open: number; high: number; low: number; close: number; volume: number; delta: number }
>;

function computeStatusFromEvent(
    crosshairX: number,
    priceHistory: PriceHistory[],
    bars: OhlcvBarMs[],
    openBar: FootprintBar,
    bounds: ViewBounds,
    chartW: number,
    barNs: bigint,
    candleCache: CandleCache | null,
    horizon: bigint,
    dataLevel: DataLevel,
    transformer: LiveTransformer,
) {
    if (dataLevel === 'l3') {
        if (priceHistory.length === 0) return null;

        const tsAtMouse = BigInt(
            Math.min(
                Number(
                    bounds.tMin +
                        BigInt(
                            Math.round((crosshairX / chartW) * Number(bounds.tMax - bounds.tMin)),
                        ),
                ),
                Number(horizon),
            ),
        );
        const snappedTs = barNs > 0n ? ((tsAtMouse + barNs / 2n) / barNs) * barNs : tsAtMouse;

        let lo = 0,
            hi = priceHistory.length - 1,
            idx = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (priceHistory[mid].ts <= snappedTs) {
                idx = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        const rec = priceHistory[idx];

        let open = 0,
            high = 0,
            low = 0,
            close = 0,
            volume = 0,
            delta = 0;
        if (barNs > 0n && candleCache) {
            const barStart = ((tsAtMouse + barNs / 2n) / barNs) * barNs;
            const cached = candleCache.get(barStart);
            if (cached) {
                open = cached.open;
                high = cached.high;
                low = cached.low;
                close = cached.close;
                volume = cached.volume;
                delta = cached.delta;
            }
        }

        const sessionOpen = priceHistory[0].bestBid;
        const change = rec.bestBid - sessionOpen;
        const changePct = sessionOpen !== 0 ? (change / sessionOpen) * 100 : 0;
        return {
            bestAsk: rec.bestAsk,
            bestBid: rec.bestBid,
            open,
            high,
            low,
            close,
            volume,
            delta,
            change,
            changePct,
        };
    }

    if (dataLevel === 'ohlcv') {
        const tsAtMouse = BigInt(Number(transformer.xToTs(crosshairX, chartW)));
        const snappedTs = Number((((tsAtMouse + barNs / 2n) / barNs) * barNs) / 1_000_000n);
        const horizonMsSnapped = Number(((horizon / barNs) * barNs) / 1_000_000n);
        const openBarMs = openBar
            ? {
                  time: Number(((openBar.ts / barNs) * barNs) / 1_000_000n),
                  open: openBar.open,
                  high: openBar.high,
                  low: openBar.low,
                  close: openBar.close,
                  volume: openBar.totalVol,
              }
            : null;
        const filteredBars = [
            ...bars.filter((b) => b.time < horizonMsSnapped),
            ...(openBarMs ? [openBarMs] : []),
        ];

        let lo = 0,
            hi = filteredBars.length - 1,
            idx = filteredBars.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (filteredBars[mid].time <= snappedTs) {
                idx = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        const bar = filteredBars[idx];
        if (!bar) return null;

        const dayStart = Math.floor(bar.time / (1000 * 60 * 60 * 24)) * (1000 * 60 * 60 * 24);
        const sessionOpen = filteredBars.filter((b) => b.time >= dayStart)[0]?.open ?? bar.open;
        const change = bar.close - sessionOpen;
        const changePct = sessionOpen !== 0 ? (change / sessionOpen) * 100 : 0;
        return {
            bestAsk: bar.close,
            bestBid: bar.close,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: Math.round(bar.volume * 1e8) / 1e8,
            delta: 0,
            change,
            changePct,
        };
    }

    return null;
}

export function StatusBar({
    cellId,
    eventBus,
    chartType,
    chartSettings,
}: {
    cellId: number;
    eventBus: TypedEventBus;
    chartType: ChartType;
    chartSettings: ChartSettings;
}) {
    const [statusLine, setStatusLine] = useState<ReturnType<typeof computeStatusFromEvent>>(null);
    const [dataLevel, setDataLevel] = useState<DataLevel>('ohlcv');

    useEffect(() => {
        return eventBus.on('status:compute', (data) => {
            // Every chart cell shares one eventBus; ignore events from other cells.
            if (data.cellId !== cellId) return;
            setDataLevel(data.dataLevel);
            setStatusLine(
                computeStatusFromEvent(
                    data.x,
                    data.priceHistory,
                    data.bars,
                    data.openBar,
                    data.bounds,
                    data.chartW,
                    data.barNs,
                    data.candleCache,
                    data.horizon,
                    data.dataLevel,
                    data.transformer,
                ),
            );
        });
    }, [eventBus, cellId]);

    if (!chartSettings.showStatusLine || !statusLine) return <div />;

    const fontSize = chartSettings.statusLineFontSize;
    const lineHeight = Math.round(fontSize * 1.45);
    const rowGap = 2;

    return (
        <div className="min-w-0">
            <div
                className="flex items-center gap-x-3 flex-wrap tabular-nums overflow-hidden"
                style={{
                    fontSize,
                    lineHeight: `${lineHeight}px`,
                    rowGap: `${rowGap}px`,
                    maxHeight: `${lineHeight * 2 + rowGap}px`,
                }}
            >
                {chartSettings.statusLineOHLC &&
                    (chartType === 'candles' ||
                        chartType === 'footprint' ||
                        chartType === 'hollow' ||
                        chartType === 'heikin-ashi' ||
                        chartType === 'bars' ||
                        chartType === 'renko' ||
                        chartType === 'kagi' ||
                        chartType === 'line-break') &&
                    statusLine.open !== 0 && (
                        <>
                            <span className="text-white/50">
                                O{' '}
                                <span className="text-white/80">{statusLine.open.toFixed(2)}</span>
                            </span>
                            <span className="text-white/50">
                                H{' '}
                                <span className="text-[#00e676]">{statusLine.high.toFixed(2)}</span>
                            </span>
                            <span className="text-white/50">
                                L{' '}
                                <span className="text-[#ff1744]">{statusLine.low.toFixed(2)}</span>
                            </span>
                            <span className="text-white/50">
                                C{' '}
                                <span className="text-white/80">{statusLine.close.toFixed(2)}</span>
                            </span>
                        </>
                    )}
                {(chartType === 'line' ||
                    chartType === 'area' ||
                    chartType === 'step' ||
                    chartType === 'baseline') && (
                    <>
                        <span className="text-white/50">
                            A{' '}
                            <span className="text-[#ff1744]">{statusLine.bestAsk.toFixed(2)}</span>
                        </span>
                        <span className="text-white/50">
                            B{' '}
                            <span className="text-[#00e676]">{statusLine.bestBid.toFixed(2)}</span>
                        </span>
                    </>
                )}
                {chartSettings.statusLineVolume && statusLine.volume > 0 && (
                    <span className="text-white/50">
                        Vol <span className="text-white/80">{statusLine.volume}</span>
                    </span>
                )}
                {chartSettings.statusLineDelta && statusLine.volume > 0 && dataLevel === 'l3' && (
                    <span
                        className={cn(statusLine.delta >= 0 ? 'text-[#00e676]' : 'text-[#ff1744]')}
                    >
                        Δ {statusLine.delta >= 0 ? '+' : ''}
                        {statusLine.delta}
                    </span>
                )}
                {chartSettings.statusLineChange && (
                    <span
                        className={cn(statusLine.change >= 0 ? 'text-[#00e676]' : 'text-[#ff1744]')}
                    >
                        {statusLine.change >= 0 ? '+' : ''}
                        {statusLine.change.toFixed(2)} ({statusLine.changePct.toFixed(2)}%)
                    </span>
                )}
            </div>
        </div>
    );
}
