import { useCallback, useSyncExternalStore } from 'react';

function subscribe(cb: () => void) {
    window.addEventListener('resize', cb);
    return () => window.removeEventListener('resize', cb);
}

export function useNarrowViewport(minWidth: number): boolean {
    const get = useCallback(() => window.innerWidth < minWidth, [minWidth]);
    return useSyncExternalStore(subscribe, get, () => false);
}
