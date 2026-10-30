// sonner is bundled into depth, so a host's <Toaster/> is another copy of it that never hears about
// these. depth mounts its own, named, so a host sharing the copy (source builds) doesn't get each twice
import { useEffect, useState, type ReactNode } from 'react';
import { toast as sonner, Toaster, type ExternalToast } from 'sonner';
import type { TypedEventBus } from '../../core/TypedEventBus';

const TOASTER_ID = 'depth';

type Show = (message: ReactNode, opts?: ExternalToast) => string | number;
const to = (opts?: ExternalToast): ExternalToast => ({ ...opts, toasterId: TOASTER_ID });

export const toast = Object.assign(((message, opts) => sonner(message, to(opts))) as Show, {
    info: ((message, opts) => sonner.info(message, to(opts))) as Show,
    success: ((message, opts) => sonner.success(message, to(opts))) as Show,
    warning: ((message, opts) => sonner.warning(message, to(opts))) as Show,
    error: ((message, opts) => sonner.error(message, to(opts))) as Show,
    custom: (render: Parameters<typeof sonner.custom>[0], opts?: ExternalToast) => sonner.custom(render, to(opts)),
    dismiss: sonner.dismiss,
});

// one per page
// a 2nd chart's would show every toast again
let claimed = false;

export function DepthToaster({ eventBus, dark: initialDark }: { eventBus: TypedEventBus; dark: boolean }) {
    const [mine, setMine] = useState(false);
    const [dark, setDark] = useState(initialDark);

    useEffect(() => {
        if (claimed) return;
        claimed = true;
        setMine(true);
        return () => {
            claimed = false;
        };
    }, []);
    useEffect(() => eventBus.on('theme:change', (theme) => setDark(theme.dark !== false)), [eventBus]);

    return mine ? <Toaster id={TOASTER_ID} theme={dark ? 'dark' : 'light'} position="bottom-right" /> : null;
}
