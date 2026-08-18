/**
 * Device pixel ratio for canvas rendering.
 *
 * All canvas sizing (handleResize) and context transforms (setTransform) must
 * use this value so the physical-pixel count and the draw-coordinate scale stay
 * in sync. Anywhere that derives cssW/cssH from canvas.width must also divide
 * by this value, not window.devicePixelRatio directly.
 *
 * Sharpness on any DPR comes from coordinate snapping (Math.floor(x)+0.5),
 * not from overriding the DPR here.
 */
export function getEffectiveDpr(): number {
    if (typeof window === 'undefined') return 1;
    return window.devicePixelRatio || 1;
}

/**
 * Round a css-px coordinate onto a whole device pixel.
 *
 * The canvas is drawn through a `setTransform(dpr, …)`, so a css coordinate of
 * 493.6 at dpr 1.25 lands on device pixel 617.0 - a *fraction* of a pixel off.
 * Fills absorb that as a soft edge; text does not. An 11px label whose baseline
 * sits half a device pixel low is antialiased across two rows of pixels and
 * reads as blurry, which is why axis labels are the first thing to look wrong.
 *
 * Use for text origins and for the edges of axis background bands. Do NOT use it
 * for data-driven geometry (candles, lines) - those need the sub-pixel precision
 * to stay where the data says they are; they use the `Math.floor(x) + 0.5`
 * stroke convention instead.
 */
export function snapToDevicePx(v: number, dpr: number = getEffectiveDpr()): number {
    return Math.round(v * dpr) / dpr;
}
