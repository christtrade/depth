import { handleLoadIngest, type LoadIngestRequest } from './slice-handlers';

self.onmessage = (e: MessageEvent<LoadIngestRequest>) => {
    const [resp, transfers] = handleLoadIngest(e.data);
    (self as any).postMessage(resp, transfers);
};
