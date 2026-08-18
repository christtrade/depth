import type { SymbolIcon as SymbolIconSpec } from '../../interfaces/IDataAdapter';
import { cn } from '../../lib/utils';

interface SymbolIconProps {
    icon?: SymbolIconSpec;
    size?: number;
    className?: string;
    fallback?: string;
}

export function SymbolIcon({ icon, size = 24, className, fallback }: SymbolIconProps) {
    const spec: SymbolIconSpec | undefined =
        typeof icon === 'string' ? { src: icon } : icon;

    if (!spec) {
        return fallback ? (
            <Monogram text={fallback} size={size} className={className} />
        ) : null;
    }

    if ('render' in spec) return <>{spec.render({ size })}</>;

    if ('src' in spec) {
        return (
            <img
                src={spec.src}
                alt={spec.alt ?? ''}
                width={size}
                height={size}
                className={cn('rounded-full object-cover shrink-0', className)}
                style={{ width: size, height: size }}
            />
        );
    }

    return (
        <Monogram
            text={spec.text}
            color={spec.color}
            size={size}
            className={className}
        />
    );
}

function Monogram({
    text,
    color,
    size,
    className,
}: {
    text: string;
    color?: string;
    size: number;
    className?: string;
}) {
    return (
        <span
            className={cn(
                'inline-flex items-center justify-center rounded-full bg-[#21242C] font-semibold shrink-0 select-none',
                className,
            )}
            style={{
                width: size,
                height: size,
                fontSize: Math.round(size * 0.4),
                color: color ?? '#9ca3af',
            }}
        >
            {text.slice(0, 3).toUpperCase()}
        </span>
    );
}
