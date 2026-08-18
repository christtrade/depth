// controller-level store of drawings, keyed by symbol.
//
// drawings are anchored to a symbol's price action, so they belong to the
// instrument rather than a pane. a pane that swaps symbols just renders a
// different bucket, and swapping back leaves the originals intact. two panes on
// the same symbol therefore share and live-edit one set.
//
// each pane reads forSymbol() and subscribes for changes to that symbol.
// mutations are immutable, each returning a fresh array, so React consumers can
// diff by reference.
import type { Drawing } from '../lib/types/drawing-types';

type Listener = () => void;

const EMPTY: readonly Drawing[] = Object.freeze([]);

export class DrawingStore {
    private bySymbol = new Map<string, Drawing[]>();
    private listeners = new Map<string, Set<Listener>>();

    // Reads
    /** Drawings for a symbol. Returns a stable empty array when none exist. */
    forSymbol(symbol: string): readonly Drawing[] {
        return this.bySymbol.get(symbol) ?? EMPTY;
    }

    /** Find a single drawing within a symbol's bucket. */
    find(symbol: string, id: string): Drawing | undefined {
        return this.bySymbol.get(symbol)?.find((d) => d.id === id);
    }

    /** Symbols that currently have at least one drawing. */
    symbols(): string[] {
        return [...this.bySymbol.keys()].filter((s) => (this.bySymbol.get(s)?.length ?? 0) > 0);
    }

    // Mutations
    add(symbol: string, drawing: Drawing): void {
        const list = this.bySymbol.get(symbol) ?? [];
        this.bySymbol.set(symbol, [...list, drawing]);
        this._changed(symbol);
    }

    update(symbol: string, id: string, patch: Partial<Drawing>): void {
        const list = this.bySymbol.get(symbol);
        if (!list) return;
        this.bySymbol.set(
            symbol,
            list.map((d) => (d.id === id ? ({ ...d, ...patch } as Drawing) : d)),
        );
        this._changed(symbol);
    }

    remove(symbol: string, id: string): void {
        const list = this.bySymbol.get(symbol);
        if (!list) return;
        const next = list.filter((d) => d.id !== id);
        if (next.length === list.length) return;
        this.bySymbol.set(symbol, next);
        this._changed(symbol);
    }

    /** Replace a symbol's whole bucket - reorder, bulk edit, restore. */
    setForSymbol(symbol: string, drawings: Drawing[]): void {
        this.bySymbol.set(symbol, [...drawings]);
        this._changed(symbol);
    }

    clearSymbol(symbol: string): void {
        if (!this.bySymbol.has(symbol)) return;
        this.bySymbol.delete(symbol);
        this._changed(symbol);
    }

    // (De)serialization
    /** Snapshot of every non-empty bucket, in the save document's shape. */
    serialize(): Record<string, Drawing[]> {
        const out: Record<string, Drawing[]> = {};
        for (const [symbol, list] of this.bySymbol) {
            if (list.length) out[symbol] = list;
        }
        return out;
    }

    /** Replace the whole store from a snapshot, notifying every symbol it touches. */
    restore(map: Record<string, Drawing[]>): void {
        const touched = new Set<string>([...this.bySymbol.keys(), ...Object.keys(map)]);
        this.bySymbol.clear();
        for (const symbol of Object.keys(map)) {
            this.bySymbol.set(symbol, [...map[symbol]]);
        }
        for (const symbol of touched) this._changed(symbol);
    }

    /** Subscribe to one symbol's bucket. Returns an unsubscribe. */
    subscribe(symbol: string, fn: Listener): () => void {
        let set = this.listeners.get(symbol);
        if (!set) {
            set = new Set();
            this.listeners.set(symbol, set);
        }
        set.add(fn);
        return () => {
            set!.delete(fn);
            if (set!.size === 0) this.listeners.delete(symbol);
        };
    }

    private _changed(symbol: string): void {
        this.listeners.get(symbol)?.forEach((fn) => fn());
    }
}
