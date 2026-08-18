export interface PluginChartTypeInitContext {
    data: unknown;
}

export interface PluginChartTypeUpdateContext {
    data: unknown;
}

export interface PluginChartTypeDrawContext {
    ctx: CanvasRenderingContext2D;
    width: number;
    height: number;
}

export interface PluginChartTypeDef {
    id: string;
    name: string;
    icon?: any;

    init(ctx: PluginChartTypeInitContext): void;
    update(ctx: PluginChartTypeUpdateContext): void;
    draw(ctx: PluginChartTypeDrawContext): void;

    // TODO: keydown events and whatever else is nice for building chart types
}

export class ChartTypeRegistry {
    private types = new Map<string, PluginChartTypeDef>();

    register(def: PluginChartTypeDef): () => void {
        if (this.types.has(def.id)) {
            console.warn(`[ChartTypeRegistry] '${def.id}' already registered - overwriting`);
        }
        this.types.set(def.id, def);
        return () => this.types.delete(def.id);
    }

    get(id: string): PluginChartTypeDef | undefined {
        return this.types.get(id);
    }

    getAll(): PluginChartTypeDef[] {
        return Array.from(this.types.values());
    }

    has(id: string): boolean {
        return this.types.has(id);
    }
}

export const chartTypeRegistry = new ChartTypeRegistry();
