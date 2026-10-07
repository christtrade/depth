export type Token = { text: string; start: number; end: number; quoted: boolean };

// ; splits statements (except inside quotes or a {json}/[json] blob)
export function splitStatements(line: string): { text: string; start: number }[] {
    const out: { text: string; start: number }[] = [];
    let start = 0;
    let quote = '';
    let depth = 0;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];

        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '{' || ch === '[') depth++;
        else if ((ch === '}' || ch === ']') && depth > 0) depth--;
        else if (ch === ';' && depth === 0) {
            out.push({ text: line.slice(start, i), start });
            start = i + 1;
        }
    }

    out.push({ text: line.slice(start), start });
    return out;
}

// | splits a statement into pipe stages
// same exemtions as ; and || is left alone
export function splitPipes(stmt: string): { text: string; start: number }[] {
    const out: { text: string; start: number }[] = [];
    let start = 0;
    let quote = '';
    let depth = 0;

    for (let i = 0; i < stmt.length; i++) {
        const ch = stmt[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '{' || ch === '[') depth++;
        else if ((ch === '}' || ch === ']') && depth > 0) depth--;
        else if (ch === '|' && depth === 0) {
            if (stmt[i + 1] === '|') {
                i++;
                continue;
            }
            out.push({ text: stmt.slice(start, i), start });
            start = i + 1;
        }
    }

    out.push({ text: stmt.slice(start), start });
    return out;
}

export function tokenize(stmt: string): Token[] {
    const tokens: Token[] = [];

    let i = 0;
    while (i < stmt.length) {
        while (i < stmt.length && /\s/.test(stmt[i])) i++;
        if (i >= stmt.length) break;
        if (stmt.startsWith('//', i)) break;

        const start = i;
        const ch = stmt[i];
        if (ch === '"' || ch === "'") {
            let text = '';
            i++;
            while (i < stmt.length && stmt[i] !== ch) {
                if (stmt[i] === '\\' && i + 1 < stmt.length) i++;
                text += stmt[i++];
            }
            i++;

            tokens.push({ text, start, end: Math.min(i, stmt.length), quoted: true });
            continue;
        }
        if (ch === '{' || ch === '[') {
            i = skipBlob(stmt, i);
            tokens.push({ text: stmt.slice(start, i), start, end: i, quoted: true });
            continue;
        }

        while (i < stmt.length && !/\s/.test(stmt[i])) {
            // name="quoted value" stays one token
            if (stmt[i] === '"' || stmt[i] === "'") {
                const q = stmt[i++];
                while (i < stmt.length && stmt[i] !== q) i++;
            }
            i++;
        }

        const raw = stmt.slice(start, Math.min(i, stmt.length));
        tokens.push({ text: raw.replace(/=(["'])(.*)\1$/, '=$2'), start, end: Math.min(i, stmt.length), quoted: false });
    }
    return tokens;
}

function skipBlob(s: string, i: number): number {
    let depth = 0;
    let quote = '';
    for (; i < s.length; i++) {
        const ch = s[i];

        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = '';
        } else if (ch === '"') quote = ch;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
            if (--depth === 0) return i + 1;
        }
    }
    return s.length;
}

// quite a value so it survives tokenize()
// (for writecfg and alias listings)
export function quote(s: string): string {
    return /^[^\s;"'{}[\]]+$/.test(s) ? s : `"${s.replace(/["\\]/g, '\\$&')}"`;
}
