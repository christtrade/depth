import type { CommandContext } from '../Console';
import { ansi } from '../values';

// a simple nano (TODO: helix!! for the goats)
export async function editText(
    ctx: CommandContext,
    opts: {
        title: string;
        name: string;
        text: string | undefined;
        highlight: (line: string) => string;
        save: (text: string) => void;
        fresh: string;
    },
): Promise<void> {
    const lines = (opts.text ?? '').split('\n');
    let row = lines.length - 1;
    let col = lines[row].length;
    let top = 0;
    let left = 0;
    let dirty = false;
    let warned = false;
    let saves = 0;
    let note = opts.text === undefined ? opts.fresh : '';

    const screen = ctx.screen();
    const view = () => Math.max(1, screen.rows - 2);

    const draw = () => {
        const h = view();
        const w = screen.cols;
        if (row < top) top = row;
        if (row >= top + h) top = row - h + 1;
        
        const gutter = String(lines.length).length + 1;
        const textW = Math.max(4, w - gutter - 1);
        
        if (col < left) left = col;
        if (col >= left + textW) left = col - textW + 1;

        const title = ` ${opts.title}${dirty ? '  [modified]' : ''}`;

        let out = `\x1b[H\x1b[7m${title.padEnd(w).slice(0, w)}\x1b[0m\r\n`;

        for (let i = 0; i < h; i++) {
            const n = top + i;
            
            if (n < lines.length) {
                const num = ansi.dim(String(n + 1).padStart(gutter - 1) + ' ');
                out += `${num} ${opts.highlight(lines[n].slice(left, left + textW))}\x1b[0m\x1b[K\r\n`;
            } else out += `${ansi.dim('~')}\x1b[K\r\n`;
        }

        const status = note ? ansi.yellow(note) : ansi.dim('^S save  ^X exit  ^C quit without saving');
        out += `${status}\x1b[K`;
        out += `\x1b[${row - top + 2};${gutter + 2 + col - left}H\x1b[?25h`;
        void screen.write(out);
    };

    const insert = (text: string) => {
        const parts = text.replace(/\r\n?/g, '\n').split('\n');
        const line = lines[row];
        const head = line.slice(0, col);
        const tail = line.slice(col);
        if (parts.length === 1) {
            lines[row] = head + parts[0] + tail;
            col += parts[0].length;
        } else {
            lines.splice(row, 1, head + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + tail);
            row += parts.length - 1;
            col = parts[parts.length - 1].length;
        }
        dirty = true;
    };

    screen.onData((data) => {
        note = '';
        if (data !== '\x18') warned = false;
        switch (data) {
            case '\x13':
                opts.save(lines.join('\n').replace(/\n+$/, ''));
                saves++;
                dirty = false;
                note = `saved ${lines.length} lines`;
                break;
            case '\x18':
                if (dirty && !warned) {
                    warned = true;
                    note = 'unsaved changes - ^S to save, ^X again to throw them away';
                    break;
                }
                screen.close();
                return;
            case '\r':
                // keep the indent, the way an editor should
                insert('\n' + (/^\s*/.exec(lines[row])?.[0] ?? ''));
                break;
            case '\x7f':
            case '\b':
                if (col > 0) {
                    lines[row] = lines[row].slice(0, col - 1) + lines[row].slice(col);
                    col--;
                } else if (row > 0) {
                    col = lines[row - 1].length;
                    lines[row - 1] += lines[row];
                    lines.splice(row--, 1);
                }
                dirty = true;
                break;
            case '\x1b[3~':
                if (col < lines[row].length) lines[row] = lines[row].slice(0, col) + lines[row].slice(col + 1);
                else if (row < lines.length - 1) lines[row] += lines.splice(row + 1, 1)[0];
                dirty = true;
                break;
            case '\x1b[A':
                row = Math.max(0, row - 1);
                break;
            case '\x1b[B':
                row = Math.min(lines.length - 1, row + 1);
                break;
            case '\x1b[D':
                if (col > 0) col--;
                else if (row > 0) col = lines[--row].length;
                break;
            case '\x1b[C':
                if (col < lines[row].length) col++;
                else if (row < lines.length - 1) (row++, (col = 0));
                break;
            case '\x1b[H':
            case '\x1bOH':
            case '\x01':
                col = 0;
                break;
            case '\x1b[F':
            case '\x1bOF':
            case '\x05':
                col = lines[row].length;
                break;
            case '\x1b[5~':
                row = Math.max(0, row - view());
                break;
            case '\x1b[6~':
                row = Math.min(lines.length - 1, row + view());
                break;
            case '\t':
                insert('    ');
                break;
            default:
                if (data.startsWith('\x1b')) break;
                insert(data.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, ''));
        }
        col = Math.min(col, lines[row].length);
        draw();
    });
    screen.onResize(draw);
    draw();

    await new Promise<void>((r) => screen.closed.addEventListener('abort', () => r(), { once: true }));
    if (dirty) ctx.print(ansi.yellow(`${opts.name}: left without saving`));
    else if (saves) ctx.print(ansi.dim(`${opts.name}: saved, ${lines.length} lines`));
}
