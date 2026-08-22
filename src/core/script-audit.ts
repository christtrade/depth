import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { STDLIB } from '../lib/indicator-stdlib';

export interface AuditFnEntry {
    name: string;
    calls: number;
    totalMs: number;
    /** Set for a user-code line rather than a stdlib call. */
    line?: number;
    /** The line's own source, trimmed - only set alongside `line`. */
    text?: string;
}

// Statements report under this prefix; no stdlib helper name can collide with it
const LINE_PREFIX = '#L';

export class AuditRecorder {
    total = 0;
    private byName = new Map<string, { calls: number; totalMs: number }>();

    record(name: string, ms: number): void {
        const e = this.byName.get(name);
        if (e) {
            e.calls++;
            e.totalMs += ms;
        } else {
            this.byName.set(name, { calls: 1, totalMs: ms });
        }
        this.total += ms;
    }

    snapshot(): AuditFnEntry[] {
        return [...this.byName.entries()]
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.totalMs - a.totalMs);
    }
}

export function timedStdlib(recorder: AuditRecorder): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(STDLIB)) {
        out[name] = (...args: unknown[]) => {
            const t0 = performance.now();
            try {
                return (fn as (...a: unknown[]) => unknown)(...args);
            } finally {
                recorder.record(name, performance.now() - t0);
            }
        };
    }
    return out;
}

export function profHandle(recorder: AuditRecorder): { record: (name: string, ms: number) => void } {
    return { record: (name, ms) => recorder.record(name, ms) };
}

export function timeOwnCode<A extends unknown[], R>(
    recorder: AuditRecorder,
    label: string,
    fn: (...args: A) => R,
): (...args: A) => R {
    return (...args: A): R => {
        const before = recorder.total;
        const t0 = performance.now();
        try {
            return fn(...args);
        } finally {
            const wall = performance.now() - t0;
            recorder.record(label, Math.max(0, wall - (recorder.total - before)));
        }
    };
}

type Edit = { pos: number; text: string; kind: 'open' | 'close' };

export function instrumentScript(src: string): string {
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true }) as any;

    const edits: Edit[] = [];
    let counter = 0;

    const isDirective = (stmt: any): boolean =>
        stmt.type === 'ExpressionStatement' && typeof stmt.directive === 'string';

    const wrapIfNeeded = (stmt: any): void => {
        if (
            stmt.type === 'EmptyStatement' ||
            stmt.type === 'DebuggerStatement' ||
            stmt.type === 'FunctionDeclaration' ||
            stmt.type === 'ClassDeclaration'
        ) {
            return;
        }

        const n = counter++;
        const line = `${LINE_PREFIX}${stmt.loc.start.line}`;
        const open = `;let __t${n}=performance.now();`;
        const close = `;__prof.record(${JSON.stringify(line)},performance.now()-__t${n});`;

        if (stmt.type === 'VariableDeclaration') {
            edits.push({ pos: stmt.start, text: open, kind: 'open' });
            edits.push({ pos: stmt.end, text: close, kind: 'close' });
        } else {
            edits.push({ pos: stmt.start, text: `${open}try{`, kind: 'open' });
            edits.push({ pos: stmt.end, text: `}finally{${close}}`, kind: 'close' });
        }
    };

    const processList = (stmts: any[]): void => {
        let i = 0;
        while (i < stmts.length && isDirective(stmts[i])) i++;
        for (; i < stmts.length; i++) {
            wrapIfNeeded(stmts[i]);
            descend(stmts[i]);
        }
    };

    const enterBody = (node: any): void => {
        if (!node) return;
        if (node.type === 'BlockStatement') processList(node.body);
        else descend(node);
    };

    const descend = (stmt: any): void => {
        switch (stmt.type) {
            case 'IfStatement':
                enterBody(stmt.consequent);
                if (stmt.alternate) enterBody(stmt.alternate);
                return;
            case 'ForStatement':
            case 'ForInStatement':
            case 'ForOfStatement':
            case 'WhileStatement':
            case 'DoWhileStatement':
                enterBody(stmt.body);
                return;
            case 'TryStatement':
                processList(stmt.block.body);
                if (stmt.handler) processList(stmt.handler.body.body);
                if (stmt.finalizer) processList(stmt.finalizer.body);
                return;
            case 'SwitchStatement':
                for (const c of stmt.cases) processList(c.consequent);
                return;
            case 'LabeledStatement':
                descend(stmt.body);
                return;
            case 'BlockStatement':
                processList(stmt.body);
                return;
            default:
                return;
        }
    };

    processList(ast.body);

    const instrumentFunctionBody = (node: any): void => {
        if (node.body?.type === 'BlockStatement') processList(node.body.body);
    };
    walk.simple(ast, {
        FunctionDeclaration: instrumentFunctionBody,
        FunctionExpression: instrumentFunctionBody,
        ArrowFunctionExpression: instrumentFunctionBody,
    });

    edits.sort((a, b) => b.pos - a.pos || (a.kind === 'open' ? -1 : 1) - (b.kind === 'open' ? -1 : 1));

    let out = src;
    for (const e of edits) out = out.slice(0, e.pos) + e.text + out.slice(e.pos);
    return out;
}

export interface AuditResult {
    wallMs: number;
    barsOrPoints: number;
    rate: number;
    entries: (AuditFnEntry & { pct: number })[];
    /** False when the script couldn't be rewritten and this fell back to
     *  timing each whole callback instead of each line inside it. */
    lineLevel: boolean;
}

const MAX_ENTRIES = 500;

export function finishAudit(
    recorder: AuditRecorder,
    wallMs: number,
    barsOrPoints: number,
    src: string,
    lineLevel: boolean,
): AuditResult {
    const lines = src.split('\n');
    const entries = recorder
        .snapshot()
        .slice(0, MAX_ENTRIES)
        .map((e) => {
            const pct = wallMs > 0 ? (e.totalMs / wallMs) * 100 : 0;
            if (!e.name.startsWith(LINE_PREFIX)) return { ...e, pct };
            const line = Number(e.name.slice(LINE_PREFIX.length));
            const text = (lines[line - 1] ?? '').trim().slice(0, 100);
            return { ...e, pct, name: `line ${line}`, line, text };
        });

    return {
        wallMs,
        barsOrPoints,
        rate: wallMs > 0 ? barsOrPoints / (wallMs / 1000) : 0,
        entries,
        lineLevel,
    };
}
