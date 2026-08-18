//  A tiny shared flag for "a non-chart UI drag owns the pointer right now".
//
//  Grid-divider resizing drives the mouse over the chart area while dragging, but
//  the per-pane chart interaction handlers listen on `window` - so a DOM shield
//  can hold the cursor but can't stop them from drawing a crosshair / panning.
//  They consult this flag and stand down while it's held.
let _locked = false;

export const pointerLock = {
    get locked() {
        return _locked;
    },
    lock() {
        _locked = true;
    },
    unlock() {
        _locked = false;
    },
};
