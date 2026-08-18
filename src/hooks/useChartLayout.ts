import { useCallback, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { getPaneLayouts, type ChartPane, type Rect } from '../lib/types/indicator-types';
import { X_AXIS_HEIGHT } from '../lib/renderers/renderer';
import { getEffectiveDpr } from '../lib/dpr';
import { type ChartSettings } from '../lib/types/chart-settings';

export interface UseChartLayoutParams {
    baseCanvasRef: RefObject<HTMLCanvasElement>;
    panesRef: MutableRefObject<ChartPane[]>;
    chartSettingsRef: MutableRefObject<ChartSettings>;
    /** Auto-computed right price-axis width (css px). */
    priceScaleWidthRef: MutableRefObject<number>;
    hideTimeScale: boolean;
}

export interface UseChartLayoutResult {
    layoutsCacheRef: MutableRefObject<Record<string, Rect>>;
    legendElemsRef: MutableRefObject<Map<string, HTMLDivElement>>;
    panePixelLayouts: Record<string, Rect>;
    recomputeLayouts: () => void;
    getLayouts: () => Record<string, Rect>;
    syncPixelLayouts: (nextPanes?: ChartPane[]) => void;
    applyLayoutsToDom: (layouts: Record<string, Rect>) => void;
}

export function useChartLayout(p: UseChartLayoutParams): UseChartLayoutResult {
    const { baseCanvasRef, panesRef, priceScaleWidthRef } = p;

    const layoutsCacheRef = useRef<Record<string, Rect>>({});
    const legendElemsRef = useRef<Map<string, HTMLDivElement>>(new Map());
    const [panePixelLayouts, setPanePixelLayouts] = useState<Record<string, Rect>>({});

    const recomputeLayouts = useCallback(() => {
        const canvas = baseCanvasRef.current;
        if (!canvas) return;
        const dpr = getEffectiveDpr();
        layoutsCacheRef.current = getPaneLayouts(
            panesRef.current,
            canvas.height / dpr - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT),
            canvas.width / dpr,
            priceScaleWidthRef.current,
        );
    }, []);

    const getLayouts = useCallback(() => {
        return layoutsCacheRef.current;
    }, []);

    const syncPixelLayouts = useCallback((nextPanes?: ChartPane[]) => {
        const canvas = baseCanvasRef.current;
        if (!canvas) return;
        const panesToUse = nextPanes ?? panesRef.current;
        const dpr = getEffectiveDpr();
        const layouts = getPaneLayouts(
            panesToUse,
            canvas.height / dpr - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT),
            canvas.width / dpr,
            priceScaleWidthRef.current,
        );
        layoutsCacheRef.current = layouts;
        setPanePixelLayouts(layouts);
    }, []);

    const applyLayoutsToDom = useCallback((layouts: Record<string, Rect>) => {
        layoutsCacheRef.current = layouts;
        for (const [paneId, rect] of Object.entries(layouts)) {
            const el = legendElemsRef.current.get(paneId);
            if (!el) continue;
            el.style.top = `${rect.y}px`;
            el.style.height = `${rect.h}px`;
            el.style.visibility = rect.h < 2 ? 'hidden' : 'visible';
        }
    }, []);

    return {
        layoutsCacheRef,
        legendElemsRef,
        panePixelLayouts,
        recomputeLayouts,
        getLayouts,
        syncPixelLayouts,
        applyLayoutsToDom,
    };
}
