import { useEffect, useRef } from 'react';

export function useForwardedRef<T>(
    forwardedRef: React.ForwardedRef<T>,
): React.MutableRefObject<T | null> {
    const localRef = useRef<T | null>(null);
    useEffect(() => {
        if (!forwardedRef) return;
        if (typeof forwardedRef === 'function') {
            forwardedRef(localRef.current);
        } else {
            forwardedRef.current = localRef.current;
        }
    });
    return localRef;
}
