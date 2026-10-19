import type { ThemeDef } from '../interfaces/plugins/IChartPlugin';

const VAR_NAME = /^[a-zA-Z0-9-]+$/;
const UNSAFE_VALUE = /[{};<>]/;

export function themeCss(theme: ThemeDef): string | null {
    const decls: string[] = [];
    for (const [name, value] of Object.entries(theme.vars ?? {})) {
        const v = String(value).trim();
        if (!VAR_NAME.test(name) || !v || UNSAFE_VALUE.test(v)) continue;
        decls.push(`--${name}: ${v};`);
    }
    if (!decls.length) return null;
    decls.push(`color-scheme: ${theme.dark === false ? 'light' : 'dark'};`);
    return `.depth-root { ${decls.join(' ')} }`;
}

export class ThemeStyle {
    private el: HTMLStyleElement | null = null;

    constructor(private readonly id: string) {}

    apply(theme: ThemeDef): void {
        if (typeof document === 'undefined') return;
        const css = themeCss(theme);
        if (!css) return this.remove();
        if (!this.el) {
            this.el = document.createElement('style');
            this.el.dataset.depthTheme = this.id;
            document.head.appendChild(this.el);
        }
        this.el.textContent = css;
    }

    remove(): void {
        this.el?.remove();
        this.el = null;
    }
}
