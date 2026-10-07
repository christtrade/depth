import ts from 'typescript';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUS = path.join(root, 'src/core/TypedEventBus.ts');
const SETTINGS = path.join(root, 'src/lib/types/chart-settings.ts');
const OUT = path.join(root, 'src/console/manifest.gen.ts');
const check = process.argv.includes('--check');
const verbose = process.argv.includes('--verbose');

const program = ts.createProgram([BUS, SETTINGS], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    noEmit: true,
    strictNullChecks: true,
});
const checker = program.getTypeChecker();

function findDecl(file, name) {
    const sf = program.getSourceFile(file);
    let found;
    sf.forEachChild((n) => {
        if ((ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && n.name.text === name) found = n;
    });
    if (!found) throw new Error(`${name} not found in ${path.relative(root, file)}`);
    return found;
}

function members(decl) {
    if (ts.isInterfaceDeclaration(decl)) return decl.members;
    if (ts.isTypeLiteralNode(decl.type)) return decl.type.members;
    throw new Error(`${decl.name.text} is not an object type`);
}

const propName = (m) => (ts.isStringLiteral(m.name) || ts.isIdentifier(m.name) ? m.name.text : m.name.getText());

function docOf(symbol) {
    const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
    return text ? text.replace(/\s*\n\s*/g, ' ') : undefined;
}

function consoleTag(symbol) {
    const tag = symbol.getJsDocTags(checker).find((t) => t.name === 'console');
    return tag ? ts.displayPartsToString(tag.text).trim() : undefined;
}

const isNull = (t) => !!(t.flags & ts.TypeFlags.Null);
const isUndef = (t) => !!(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void));
const isBoolLike = (t) => !!(t.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral));

function typeName(t) {
    const sym = t.aliasSymbol ?? t.getSymbol();
    const name = sym?.getName();
    if (!name || name.startsWith('__')) return undefined;
    const file = sym.declarations?.[0]?.getSourceFile().fileName ?? '';
    return file.startsWith(path.join(root, 'src')) ? name : undefined;
}

const isOpenString = (t) =>
    t.isIntersection() && t.types.some((p) => p.flags & ts.TypeFlags.String);

function declaredOrder(t, node) {
    const aliasDecl = t.aliasSymbol?.declarations?.[0];
    const union = aliasDecl && ts.isTypeAliasDeclaration(aliasDecl) ? aliasDecl.type : node;
    if (!union || !ts.isUnionTypeNode(union)) return [];
    return union.types
        .filter((n) => ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal))
        .map((n) => n.literal.text);
}

function mapType(t, hint, node) {
    let nullable = false;
    let optional = false;
    if (t.isUnion()) {
        const parts = t.types.filter((p) => {
            if (isNull(p)) return !(nullable = true);
            if (isUndef(p)) return !(optional = true);
            return true;
        });
        if (parts.length === 0) return { type: { kind: 'json' }, nullable, optional };
        if (parts.every(isBoolLike)) return { type: { kind: 'boolean' }, nullable, optional };
        if (parts.length > 1) {
            const lits = parts.filter((p) => p.isStringLiteral());
            const open = parts.some(isOpenString) || parts.some((p) => p.flags & ts.TypeFlags.String);
            if (lits.length && lits.length + (open ? 1 : 0) === parts.length) {
                const order = declaredOrder(t, node);
                const rank = (v) => (order.includes(v) ? order.indexOf(v) : order.length);
                const values = lits.map((p) => p.value).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
                const type = { kind: 'enum', values };
                if (open) type.open = true;
                return { type, nullable, optional };
            }
            return { type: { kind: 'json' }, nullable, optional };
        }
        t = parts[0];
    }
    return { type: mapSingle(t, hint), nullable, optional };
}

function mapSingle(t, hint) {
    if (t.flags & ts.TypeFlags.String) return /Color$/.test(hint ?? '') ? { kind: 'color' } : { kind: 'string' };
    if (t.flags & ts.TypeFlags.Number) return { kind: 'number' };
    if (t.flags & ts.TypeFlags.BigInt) return { kind: 'bigint' };
    if (isBoolLike(t)) return { kind: 'boolean' };
    if (t.isStringLiteral()) return { kind: 'enum', values: [t.value] };
    if (isOpenString(t)) return { kind: 'string' };
    if (checker.isArrayType(t)) {
        const of = mapSingle(checker.getTypeArguments(t)[0]);
        return of.kind === 'json' ? of : { kind: 'list', of };
    }
    const name = typeName(t);
    return name && t.flags & ts.TypeFlags.Object ? { kind: 'named', name } : { kind: 'json' };
}

const SCAN_ROOTS = [path.join(root, 'src'), path.join(root, '../christtrade/src')];

async function scanUsage() {
    const listened = new Set();
    const emitted = new Set();
    const walk = async (dir) => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name !== 'node_modules' && !e.name.startsWith('.')) await walk(p);
            } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && p !== BUS) {
                const text = await readFile(p, 'utf8');
                for (const m of text.matchAll(/\.(?:on|once|intercept)\s*\(\s*['"]([\w:-]+)['"]/g)) listened.add(m[1]);
                for (const m of text.matchAll(/\.emit\s*\(\s*['"]([\w:-]+)['"]/g)) emitted.add(m[1]);
            }
        }
    };
    for (const r of SCAN_ROOTS) await walk(r);
    return { listened, emitted };
}

// events
const VERBS = new Set([
    'set', 'add', 'remove', 'goto', 'reset', 'open', 'play', 'pause', 'step', 'flatten',
    'buy', 'sell', 'apply', 'recompute', 'cancel', 'deposit', 'withdraw', 'refresh',
    'rehydrate', 'redraw', 'run', 'request', 'prefetch', 'rebuild', 'refine', 'toggle',
    'search', 'audit', 'change', 'update',
]);
// one word 'x:update'/change etc are reports and not orders
const REPORT_ONLY = new Set(['update', 'change']);
const DEV_NS = new Set([
    'data', 'render-engine', 'hitmap', 'status', 'layout', 'execution', 'features',
    'pane', 'indicator', 'heatmap', 'session',
]);
const DEV_PLUGIN = /^(register|unregister|scripted|add-indicator|update-code)|-item-/;

const REPORT_SUFFIX = /-(failed|result|error|done|added|removed|updated|cancelled|rejected|response|resolved|computed)$/;

const unhandled = [];

function classify(event, doc, tag, usage) {
    const [ns, ...rest] = event.split(':');
    const action = rest.join(':');
    const dev = DEV_NS.has(ns) || (ns === 'plugin' && DEV_PLUGIN.test(action)) || undefined;
    if (tag === 'event') return { kind: 'event' };
    if (tag === 'command') return { kind: 'command', dev };
    if (tag === 'dev') return { kind: 'command', dev: true };

    const words = action.split(/[-:]/);
    const verbish =
        /^Command:/.test(doc ?? '') ||
        (!REPORT_SUFFIX.test(action) &&
            ((words.length === 1 ? VERBS.has(words[0]) && !REPORT_ONLY.has(words[0]) : VERBS.has(words[0])) ||
                (words.length > 1 && (words.at(-1) === 'cancel' || words.at(-1) === 'run'))));
    if (!verbish) return { kind: 'event' };
    if (!usage.listened.has(event)) {
        unhandled.push(event);
        return { kind: 'event' };
    }
    return { kind: 'command', dev };
}

function argsOf(payload) {
    if (isUndef(payload)) return { spread: false, args: [] };
    const anonObject =
        payload.flags & ts.TypeFlags.Object &&
        !checker.isArrayType(payload) &&
        !typeName(payload) &&
        !payload.isUnion();
    const empty = payload.flags & ts.TypeFlags.Object && payload.getProperties().length === 0 && !checker.isArrayType(payload);
    if (empty) return { spread: true, args: [] };
    if (!anonObject) {
        const { type, nullable, optional } = mapType(payload);
        return { spread: false, args: [clean({ name: 'value', type, optional, nullable })] };
    }
    const args = payload.getProperties().map((p) => {
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        const t = checker.getTypeOfSymbolAtLocation(p, decl);
        const { type, nullable, optional } = mapType(t, p.getName(), decl?.type);
        return clean({
            name: p.getName(),
            type,
            optional: optional || !!(p.flags & ts.SymbolFlags.Optional),
            nullable,
            doc: docOf(p),
        });
    });
    // required first so positional args read naturally
    args.sort((a, b) => (a.optional ? 1 : 0) - (b.optional ? 1 : 0));
    return { spread: true, args };
}

function clean(o) {
    for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === false) delete o[k];
    return o;
}

function events(usage) {
    const decl = findDecl(BUS, 'ChartEvents');
    const ifaceType = checker.getTypeAtLocation(decl);
    return members(decl).map((m) => {
        const event = propName(m);
        const sym = ifaceType.getProperty(event);
        const doc = docOf(sym);
        const { kind, dev } = classify(event, doc, consoleTag(sym), usage);
        const { spread, args } = argsOf(checker.getTypeOfSymbolAtLocation(sym, m));
        return clean({ event, kind, dev, spread, args, doc });
    });
}

function cvars() {
    const decl = findDecl(SETTINGS, 'ChartSettings');
    const sf = decl.getSourceFile();
    const text = sf.getFullText();
    const objType = checker.getTypeAtLocation(decl);
    let group;
    const out = [];
    for (const m of members(decl)) {
        const name = propName(m);
        const sym = objType.getProperty(name);

        for (const r of ts.getLeadingCommentRanges(text, m.getFullStart()) ?? []) {
            const c = text.slice(r.pos, r.end);
            const header = /^\/\/\s*([A-Z][\w ]{0,30})$/.exec(c);
            if (header) group = header[1].trim();
        }
        const trailing = (ts.getTrailingCommentRanges(text, m.getEnd()) ?? [])
            .map((r) => text.slice(r.pos, r.end).replace(/^\/\/\s*/, '').trim())
            .join(' ');
        const { type, nullable } = mapType(checker.getTypeOfSymbolAtLocation(sym, m), name, m.type);
        if (type.kind === 'json') continue;
        out.push(clean({ name, type, nullable, group, doc: docOf(sym) ?? (trailing || undefined) }));
    }
    return out;
}

function render(evs, vars) {
    const line = (o) => `    ${JSON.stringify(o)},`;
    return [
        '// Generated by build/console-manifest.mjs - do not edit.',
        "import type { CvarSpec, EventSpec } from './types';",
        '',
        'export const EVENTS: EventSpec[] = [',
        ...evs.map(line),
        '];',
        '',
        'export const CVARS: CvarSpec[] = [',
        ...vars.map(line),
        '];',
        '',
    ].join('\n');
}

const evs = events(await scanUsage());
const vars = cvars();
const src = render(evs, vars);

const cmds = evs.filter((e) => e.kind === 'command');
const raw = cmds.filter((e) => e.args.some((a) => !a.optional && (a.type.kind === 'json' || a.type.kind === 'named')));
console.log(
    `events ${evs.length}: ${cmds.length} commands (${cmds.filter((c) => c.dev).length} dev, ${raw.length} need json/named args), ` +
        `${evs.length - cmds.length} listen-only | cvars ${vars.length}`,
);
if (unhandled.length) console.log(`named like commands but nothing listens: ${unhandled.join(', ')}`);
if (verbose) {
    for (const e of evs)
        console.log(
            `  ${e.kind === 'command' ? (e.dev ? 'dev ' : 'cmd ') : '    '} ${e.event}  ${e.args
                .map((a) => `${a.optional ? '[' : '<'}${a.name}:${a.type.kind === 'named' ? a.type.name : a.type.kind}${a.optional ? ']' : '>'}`)
                .join(' ')}`,
        );
}

if (check) {
    const current = await readFile(OUT, 'utf8').catch(() => '');
    if (current !== src) {
        console.error('src/console/manifest.gen.ts is stale - run npm run console:manifest');
        process.exit(1);
    }
} else {
    await writeFile(OUT, src);
}
