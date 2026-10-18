import type { DrawHook, DrawPhase, RenderEngine } from './RenderEngine';

type Engine = Pick<RenderEngine, 'cellId' | 'addDrawHook' | 'setFocused'>;

// every layout cell's render engine, and the overlays that go on all of them.
// plugins are installed once per layout, so an overlay can't belong to one
// engine - a cell mounting later, or remounting on a layout switch, gets it too
export class CellEngines<E extends Engine = RenderEngine> {
    private readonly engines = new Map<number, E>();
    private readonly overlays = new Set<{
        phase: DrawPhase;
        hook: DrawHook;
        offs: Map<E, () => void>;
    }>();
    private focusedCell = 0;

    attach(engine: E): void {
        // a cell remounting hands over a new engine under the same id
        const prev = this.engines.get(engine.cellId);
        if (prev && prev !== engine) this.detach(prev);

        this.engines.set(engine.cellId, engine);
        engine.setFocused(engine.cellId === this.focusedCell);
        for (const o of this.overlays) o.offs.set(engine, engine.addDrawHook(o.phase, o.hook));
    }

    detach(engine: E): void {
        if (this.engines.get(engine.cellId) === engine) this.engines.delete(engine.cellId);
        for (const o of this.overlays) {
            o.offs.get(engine)?.();
            o.offs.delete(engine);
        }
    }

    focus(cell: number): void {
        this.focusedCell = cell;
        for (const engine of this.engines.values()) engine.setFocused(engine.cellId === cell);
    }

    /** The focused cell's engine, or any if that cell hasn't mounted */
    get focused(): E | null {
        return this.engines.get(this.focusedCell) ?? this.engines.values().next().value ?? null;
    }

    get all(): ReadonlyMap<number, E> {
        return this.engines;
    }

    addOverlay(phase: DrawPhase, hook: DrawHook): () => void {
        const o = { phase, hook, offs: new Map<E, () => void>() };
        this.overlays.add(o);
        for (const engine of this.engines.values())
            o.offs.set(engine, engine.addDrawHook(phase, hook));
        return () => {
            if (!this.overlays.delete(o)) return;
            o.offs.forEach((off) => off());
            o.offs.clear();
        };
    }
}
