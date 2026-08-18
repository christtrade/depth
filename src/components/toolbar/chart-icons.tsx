import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

type IconProps = { className?: string };

function Glyph({ className, children }: { className?: string; children: ReactNode }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn('w-5 h-5', className)}
        >
            {children}
        </svg>
    );
}

function CandlePair({ filled }: { filled: boolean }) {
    const bodyFill = filled ? 'currentColor' : 'none';
    const bodyStroke = filled ? 'none' : 'currentColor';
    return (
        <>
            <path d="M8 3v5M8 16v5" />
            <rect x="5.5" y="8" width="5" height="8" rx="1" fill={bodyFill} stroke={bodyStroke} />
            <path d="M16 5v4M16 15v4" />
            <rect x="13.5" y="9" width="5" height="6" rx="1" fill={bodyFill} stroke={bodyStroke} />
        </>
    );
}

export function CandlesIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <CandlePair filled />
        </Glyph>
    );
}

export function HollowIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <CandlePair filled={false} />
        </Glyph>
    );
}

export function HeikinAshiIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <rect x="4" y="11" width="4" height="8" rx="0.5" fill="currentColor" stroke="none" />
            <path d="M6 8v3" />
            <rect x="10" y="7" width="4" height="8" rx="0.5" fill="currentColor" stroke="none" />
            <path d="M12 4v3" />
            <rect x="16" y="4" width="4" height="8" rx="0.5" fill="currentColor" stroke="none" />
            <path d="M18 12v3" />
        </Glyph>
    );
}

export function BarsIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <path d="M8 4v12" />
            <path d="M8 7H5" />
            <path d="M8 12h3" />
            <path d="M16 8v12" />
            <path d="M16 11h-3" />
            <path d="M16 16h3" />
        </Glyph>
    );
}

export function BaselineIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <path d="M3 12h26" strokeDasharray="2 1" />
            <path d="M2 18 10 9l6 6 20-23" />
        </Glyph>
    );
}

export function AreaIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <path
                d="M3 15 9 11l4 3 8-6v14H3Z"
                fill="currentColor"
                fillOpacity={0.18}
                stroke="none"
            />
            <path d="M3 15 9 11l4 3 8-6" />
        </Glyph>
    );
}

export function LineIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <path d="M2 18 10 9l6 6 20-23" />
        </Glyph>
    );
}

export function StepIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <path d="M3 16h5v-5h5v3h5V7h2" />
        </Glyph>
    );
}

export function RenkoIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <rect
                x="3"
                y="14"
                width="5.5"
                height="5.5"
                rx="0.5"
                fill="currentColor"
                stroke="none"
            />
            <rect
                x="9.25"
                y="8.25"
                width="5.5"
                height="5.5"
                rx="0.5"
                fill="currentColor"
                stroke="none"
            />
            <rect
                x="15.5"
                y="2.5"
                width="5.5"
                height="5.5"
                rx="0.5"
                fill="currentColor"
                stroke="none"
            />
        </Glyph>
    );
}

export function KagiIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <path d="M5 4v9h6V8" strokeWidth={1.2} />
            <path d="M11 8v8h6v-6" strokeWidth={2.8} />
        </Glyph>
    );
}

export function LineBreakIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <rect x="3" y="13" width="5" height="7" rx="0.5" fill="currentColor" stroke="none" />
            <rect x="9.5" y="8" width="5" height="9" rx="0.5" fill="currentColor" stroke="none" />
            <rect x="16" y="4" width="5" height="7" rx="0.5" />
        </Glyph>
    );
}

export function FootprintIcon({ className }: IconProps) {
    return (
        <Glyph className={className}>
            <rect x="4" y="5" width="16" height="14" rx="1" />
            <path d="M12 5v14" />
            <path d="M4 10h16" />
            <path d="M4 14h16" />
        </Glyph>
    );
}
