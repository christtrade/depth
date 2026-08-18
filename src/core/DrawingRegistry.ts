
import type {
    Anchor,
    DrawingAnchorId,
    PluginDraftDrawing,
    PluginDrawing,
} from '../lib/types/drawing-types';
import type { LiveTransformer } from '../interfaces/ICoordinateTransformer';
import type { StyleField } from '../components/drawings/drawing-settings-dialog';

export interface PluginDrawingRenderContext {
    ctx: CanvasRenderingContext2D;
    anchors: Anchor[];
    w: number; // chart width (px, excluding y-axis)
    h: number; // pane height (px)
    oy: number; // pane y offset (px)
    transformer: LiveTransformer;
    selected: boolean;
    hovered: boolean;
    hotAnchor: DrawingAnchorId | null;
    data: unknown; // plugin's own serialized data
}

export interface PluginDrawingHitContext {
    mx: number;
    my: number;
    anchors: Anchor[];
    w: number;
    h: number;
    oy: number;
    transformer: LiveTransformer;
    data: unknown;
}

export interface PluginDrawingToolDef {
    /** Must be globally unique. Use reverse-domain: 'com.myname.anchored-vwap' */
    id: string;
    name: string;
    icon?: string; // svg string or emoji
    cursor?: string; // css cursor value, default 'crosshair'

    /**
     * Number of anchor clicks to commit the drawing.
     * 'dynamic' = user keeps clicking, presses Escape to finish.
     */
    anchorCount: number | 'dynamic';

    /**
     * Render the committed drawing, on every canvas frame. Use ctx.anchors plus
     * the transformer to get from data space to pixels. You must call
     * ctx.save()/restore() if you change global canvas state.
     */
    render(ctx: PluginDrawingRenderContext): void;

    /**
     * Is the mouse over this drawing? Called with each anchor's pixel position
     * already resolved, though you can do your own geometry. Return the anchor
     * id that was hit, null for a body hit, or false for no hit.
     */
    hitTest(ctx: PluginDrawingHitContext): DrawingAnchorId | 'body' | false;

    /**
     * Called while the user is still placing anchors. Return draw commands for
     * the preview, same signature as render. Without it, a dot is drawn at the
     * last placed anchor.
     */
    preview?(ctx: PluginDrawingRenderContext & { cursorAnchor: Anchor }): void;

    /**
     * Default style/data merged into the drawing on creation.
     * Returned from getSettings() / stored in drawing.data.
     */
    defaultData?: unknown;

    /**
     * Fields for the Style tab of the drawing settings dialog. Each field's
     * `key` names a key in the drawing's own `data`, so every drawing made with
     * this tool is styled independently. Build them with the `StyleField`
     * helpers exported alongside the dialog.
     */
    settingsSchema?: StyleField[];

    /**
     * Raw pointer and keyboard events while this tool is active. The plugin gets
     * every event and can call ctx methods to commit drawings, update the draft,
     * request redraws. Return true to stop the event reaching the chart's own
     * handlers.
     */
    onPointerDown?(event: PluginToolEvent): boolean | void;
    onPointerMove?(event: PluginToolEvent): boolean | void;
    onPointerUp?(event: PluginToolEvent): boolean | void;
    onKeyDown?(event: PluginKeyEvent): boolean | void;
    onMove?(ctx: PluginDrawingMoveContext): unknown;
    onActivate?(ctx: PluginToolActiveContext): void; // tool was selected
    onDeactivate?(): void;
}

export interface PluginToolEvent {
    // Data-space coords (already transformed)
    ts: bigint;
    price: number;
    // Pixel coords relative to chart area
    x: number;
    y: number;
    // Modifiers
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    buttons: number;
    // Actions the plugin can take
    tool: PluginToolActiveContext;
    plugin: PluginDrawingToolDef;
}

export interface PluginKeyEvent {
    key: string;
    code: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    tool: PluginToolActiveContext;
}

export interface PluginDrawingMoveContext {
    data: unknown;
    anchors: Anchor[];
    anchor: DrawingAnchorId; // 'body' or 'a0', 'a1', etc.
    dts: bigint;
    dprice: number;
    curTs: bigint;
    curPrice: number;
}

export interface PluginToolActiveContext {
    /** Commit a drawing to the drawings array */
    /** keepActive leaves the tool armed, for tools you place several of in a row. */
    commitDrawing(drawing: Omit<PluginDrawing, 'id'> & { keepActive?: boolean }): void;
    /** Update the current draft (triggers redraw) */
    setDraft(draft: PluginDraftDrawing | null): void;
    /** Request a canvas redraw without changing draft */
    requestRedraw(): void;
    /** Deactivate this tool and return to cursor */
    deactivate(): void;
    /** The overlay canvas - for tools that want to paint directly every frame */
    getOverlayCanvas(): HTMLCanvasElement;
}

export class DrawingRegistry {
    private tools = new Map<string, PluginDrawingToolDef>();

    register(def: PluginDrawingToolDef): () => void {
        if (this.tools.has(def.id)) {
            console.warn(`[DrawingRegistry] '${def.id}' already registered - overwriting`);
        }
        this.tools.set(def.id, def);
        return () => this.tools.delete(def.id);
    }

    get(id: string): PluginDrawingToolDef | undefined {
        return this.tools.get(id);
    }

    getAll(): PluginDrawingToolDef[] {
        return Array.from(this.tools.values());
    }

    has(id: string): boolean {
        return this.tools.has(id);
    }
}

export const drawingRegistry = new DrawingRegistry();
