import { useEffect, type MutableRefObject, type RefObject } from 'react';
import { RenderEngine } from '../core/RenderEngine';
import { type TypedEventBus } from '../core/TypedEventBus';
import { type ViewBounds } from '../lib/types';

export interface UseRenderEngineParams {
    renderEngineRef: MutableRefObject<RenderEngine | null>;
    baseCanvasRef: RefObject<HTMLCanvasElement>;
    drawingsCanvasRef: RefObject<HTMLCanvasElement>;
    uiCanvasRef: RefObject<HTMLCanvasElement>;
    eventBus: TypedEventBus;
    /** Which cell of the layout this chart is - stamped onto bus events so the
     *  other cells can tell our repaints from theirs. */
    chartId: number;
    viewRef: MutableRefObject<ViewBounds | null>;
}

export function useRenderEngine(p: UseRenderEngineParams): void {
    const { renderEngineRef, baseCanvasRef, drawingsCanvasRef, uiCanvasRef, eventBus, chartId, viewRef } = p;

    useEffect(() => {
        const base = baseCanvasRef.current;
        const drawings = drawingsCanvasRef.current;
        const ui = uiCanvasRef.current;
        if (!base || !drawings || !ui) return;

        const engine = new RenderEngine(base, drawings, ui, eventBus, chartId);
        renderEngineRef.current = engine;
        eventBus.emit('render-engine:ready', { engine: renderEngineRef.current });

        if (viewRef.current) engine.setView(viewRef.current);

        return () => engine.destroy();
    }, []);
}
