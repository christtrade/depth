/**
 * Contract for plugins that register a custom drawing tool.
 * Drawing plugins declare type: 'drawing' and require the
 * 'drawing:register' permission. The actual tool definition
 * is registered via ctx.registerDrawingTool(tool) inside install().
 *
 * For a simpler path to custom drawing tools, implement PluginDrawingToolDef
 * directly and register it from any extension plugin - a full DrawingPlugin
 * is only necessary when you need plugin lifecycle hooks (settings, state).
 */

import type { ChartPlugin } from './IChartPlugin';
import type { Anchor } from '../../lib/types/drawing-types';
import type { PluginDrawingRenderContext, PluginDrawingHitContext } from '../../core/DrawingRegistry';
import type { OhlcvBar } from '../IDataAdapter';

// Pixel-space point (for cursor / preview coords)
export interface Point {
    x: number;
    y: number;
}

// Anchor configuration returned by createAnchors()
export type AnchorConfig = {
    ts: bigint;
    price: number;
};

// Drawing plugin interface
export interface DrawingPlugin extends ChartPlugin {
    type: 'drawing';

    /** ID of the drawing tool this plugin registers - must be globally unique. */
    toolId: string;

    /** SVG string or emoji shown in the drawing toolbar. */
    icon?: string;

    /**
     * How many anchor clicks are needed to commit the drawing.
     * 'dynamic' = user keeps clicking and presses Escape to finish.
     */
    anchorCount: number | 'dynamic';

    /**
     * Return initial anchor positions when the user starts placing the drawing.
     * `start` is the first click in data space.
     */
    createAnchors(start: AnchorConfig): AnchorConfig[];

    /**
     * Full render of the committed drawing. Called every canvas frame.
     * Receives the full PluginDrawingRenderContext including resolved pixel positions.
     */
    render(ctx: PluginDrawingRenderContext): void;

    /**
     * Live preview while the user is still placing anchors.
     * `cursor` is the current mouse position in data space.
     */
    preview?(anchors: Anchor[], cursor: AnchorConfig): void;

    /**
     * Return true (or the anchor id that was hit) if the mouse is over this drawing.
     * Return false for no hit.
     */
    hitTest(ctx: PluginDrawingHitContext): boolean | string | null;

    /**
     * Optionally snap an anchor to the nearest bar OHLC value during placement.
     */
    snap?(anchor: Anchor, bars: OhlcvBar[]): Anchor;

    /** Serialise anchor positions to a JSON-safe value for persistence. */
    serialize(anchors: Anchor[]): unknown;

    /** Restore anchors from a previously serialised value. */
    deserialize(data: unknown): Anchor[];
}
