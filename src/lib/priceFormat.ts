import type { SymbolInfo } from '../core';

/**
 * Format a price using the symbol's display precision (`priceFormat.precision`),
 * falling back to 2 decimal places when the symbol info is absent. This is the
 * single source of truth for how prices are rendered across the chart, so axis
 * labels, pills, tooltips and trade lines all stay consistent.
 */
export function formatPrice(value: number, symbolInfo?: SymbolInfo): string {
    const tick = symbolInfo?.priceFormat?.minTick ?? 0.01;
    const roundedValue = Math.round(value * (1 / tick)) / (1 / tick);

    const precision = symbolInfo?.priceFormat?.precision ?? 2;
    return roundedValue.toFixed(precision);
}

/** Fallback tick used when a symbol provides no price metadata at all. */
export const DEFAULT_TICK_SIZE = 0.25;

/**
 * Resolve the instrument's minimum price increment from symbol info, preferring
 * `priceFormat.minTick`, then the deprecated `tickSize`, and finally a sensible
 * default. Single source of truth for tick snapping, footprint/volume-profile
 * bucketing and tick-distance readouts so they all match the instrument.
 */
export function resolveTickSize(symbolInfo?: SymbolInfo | null): number {
    return symbolInfo?.priceFormat?.minTick ?? symbolInfo?.tickSize ?? DEFAULT_TICK_SIZE;
}
