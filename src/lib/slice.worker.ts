import { handleSliceRequest, type SliceWorkerRequest } from './slice-handlers';

self.onmessage = (e: MessageEvent<SliceWorkerRequest>) => {
    const [resp, transfers] = handleSliceRequest(e.data);
    (self as any).postMessage(resp, transfers);
};
