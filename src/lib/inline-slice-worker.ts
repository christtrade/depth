import { handleLoadIngest, type LoadIngestRequest } from './slice-handlers';

// engine tests run the slice worker on the main thread (node had no worker)
export function installInlineSliceWorker(): void {
    if (typeof (globalThis as any).Worker !== 'undefined') return;
    (globalThis as any).Worker = class {
        onmessage: ((e: { data: unknown }) => void) | null = null;
        onerror: ((e: unknown) => void) | null = null;
        postMessage(req: LoadIngestRequest) {
            setTimeout(() => {
                const [resp] = handleLoadIngest(req);
                this.onmessage?.({ data: resp });
            });
        }
        terminate() {}
    };
}
