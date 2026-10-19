import type { ThemeDef } from '../interfaces/plugins/IChartPlugin';
import type { TypedEventBus } from './TypedEventBus';
import { BASE_DARK_VARS, BUILTIN_THEMES } from './builtin-themes';

export { BASE_DARK_VARS, BUILTIN_THEMES };
export const DEFAULT_THEME_ID = 'dark';

export class ThemeRegistry {
    private readonly themes = new Map<string, ThemeDef>();
    private currentId = DEFAULT_THEME_ID;

    constructor(
        private readonly bus: TypedEventBus,
        builtins: readonly ThemeDef[] = BUILTIN_THEMES,
        initial?: string,
    ) {
        for (const t of builtins) this.themes.set(t.id, t);
        if (initial && this.themes.has(initial)) this.currentId = initial;
    }

    get current(): ThemeDef {
        return this.themes.get(this.currentId) ?? this.themes.get(DEFAULT_THEME_ID)!;
    }

    get(id: string): ThemeDef | undefined {
        return this.themes.get(id);
    }

    list(): ThemeDef[] {
        return [...this.themes.values()];
    }

    /** Same id replaces, so a hot-reloaded theme updates in place. Returns the unregister. */
    register(theme: ThemeDef): () => void {
        this.themes.set(theme.id, theme);
        this.bus.emit('theme:list', this.list());
        if (theme.id === this.currentId) this.bus.emit('theme:change', theme);
        return () => {
            if (this.themes.get(theme.id) !== theme || theme.id === DEFAULT_THEME_ID) return;
            this.themes.delete(theme.id);
            this.bus.emit('theme:list', this.list());
            if (theme.id !== this.currentId) return;

            queueMicrotask(() => {
                if (theme.id === this.currentId && !this.themes.has(theme.id)) this.set(DEFAULT_THEME_ID);
            });
        };
    }

    /** False for an unknown id. Setting the current theme again does nothing. */
    set(id: string): boolean {
        const theme = this.themes.get(id);
        if (!theme) return false;
        if (id === this.currentId) return true;
        this.currentId = id;
        this.bus.emit('theme:change', theme);
        return true;
    }
}
