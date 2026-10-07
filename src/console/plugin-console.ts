import type { ArgSpec, ArgType } from './types';
import type { CvarDef } from './Console';

export type ScriptCommandMeta = { name: string; help?: string; args: Record<string, unknown> };

// "MA Cross" -> "ma-cross" so just the namespace a scipt's commands and cvars live under
export function slugOf(name: string): string {
    return (
        String(name ?? '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'script'
    );
}

const SIMPLE = new Set(['string', 'number', 'boolean', 'time', 'duration', 'color', 'json']);

function argType(t: unknown): ArgType {
    if (Array.isArray(t)) return { kind: 'enum', values: t.map(String) };
    if (typeof t === 'string' && SIMPLE.has(t)) return { kind: t } as ArgType;
    return { kind: 'string' };
}

export function scriptArgSpecs(args: Record<string, unknown>): ArgSpec[] {
    return Object.entries(args ?? {}).map(([name, raw]) => {
        const full = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { type: raw };
        const spec: ArgSpec = { name, type: argType(full.type ?? full.options) };
        if (full.optional) spec.optional = true;
        if (typeof full.help === 'string') spec.doc = full.help;
        return spec;
    });
}

type ParamDefLike = { type: string; label?: string; options?: unknown[] } & Record<string, unknown>;

// one cvar per settings key a scripts params produce "ma-cross.fast".
// paired params store several keys and each becomes its own cvar with the type its default has
export function paramCvars(opts: {
    slug: string;
    paramDefs: Record<string, ParamDefLike>;
    defaults: Record<string, unknown>;
    keysOf: (key: string, def: ParamDefLike) => string[];
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
    group: string;
}): CvarDef[] {
    const out: CvarDef[] = [];
    for (const [key, def] of Object.entries(opts.paramDefs)) {
        for (const leaf of opts.keysOf(key, def)) {
            const dflt = opts.defaults[leaf];
            let type: ArgType;

            if (def.type === 'select' || def.type === 'buttonGroup') {
                const options = (def.options ?? []).map((o) => (typeof o === 'object' && o ? String((o as { value: unknown }).value) : String(o)));
                type = { kind: 'enum', values: options };
            } else if (typeof dflt === 'boolean') type = { kind: 'boolean' };
            else if (typeof dflt === 'number') type = { kind: 'number' };
            else if (typeof dflt === 'string' && (/color/i.test(def.type + leaf) || /^#[0-9a-f]{3,8}$/i.test(dflt))) type = { kind: 'color' };
            else if (typeof dflt === 'string') type = { kind: 'string' };
            else continue;

            out.push({
                name: `${opts.slug}.${leaf}`,
                type,
                help: def.label,
                group: opts.group,
                default: dflt,
                get: () => opts.get(leaf),
                set: (v) => opts.set(leaf, v),
            });
        }
    }
    return out;
}
