'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { Pin, PinOff, Minus, ExternalLink } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable';
import { TypedEventBus } from '../../core/TypedEventBus';
import { DepthChart } from '../../core';
import { StorageKey, readJSON, writeJSON } from '../../lib/storage';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card'

export interface PanelEntry {
    id: string;
    title: string;
    element: React.ReactNode;
    visible: boolean;
}

export function DomPortal({ element }: { element: React.ReactNode }) {
    return <>{element}</>;
}

function PanelShell({
    panel,
    pinned,
    onTogglePin,
    onDragHeader,
    onToggleVisibility,
    onDragStart,
    onDragEnd,
}: {
    panel: PanelEntry;
    pinned: boolean;
    onTogglePin: () => void;
    onToggleVisibility: () => void;
    onDragHeader?: (e: React.MouseEvent) => void;
    onDragStart?: () => void;
    onDragEnd?: () => void;
}) {
    const handleDragStart = (e: React.DragEvent) => {
        e.dataTransfer.setData('text/plain', panel.id);
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => onDragStart?.(), 0);
    };

    return (
        <div
            className="flex flex-col flex-1 min-h-0 overflow-hidden bg-background"
        >
            <div
                className={cn(
                    'flex items-center h-8 px-2 gap-1.5 border-b border-border shrink-0 select-none bg-background',
                    'cursor-grab active:cursor-grabbing',
                )}
                draggable={pinned}
                onDragStart={pinned ? handleDragStart : undefined}
                onDragEnd={pinned ? onDragEnd : undefined}
                onMouseDown={!pinned ? onDragHeader : undefined}
            >
                <span className="text-xs font-medium text-foreground/70 flex-1 truncate">
                    {panel.title}
                </span>
                <div className="flex flex-row items-center">
                    <Tooltip delayDuration={700}>
                        <TooltipTrigger asChild>
                            <button
                                className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                                onClick={onTogglePin}
                            >
                                {pinned ? <PinOff size={12} /> : <Pin size={12} />}
                            </button>
                        </TooltipTrigger>
                        <TooltipContent className="bg-background border border-border">
                            {pinned ? 'Make floating' : 'Pin to sidebar'}
                        </TooltipContent>
                    </Tooltip>
                    <Tooltip delayDuration={700}>
                        <TooltipTrigger asChild>
                            <button
                                className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                                onClick={onToggleVisibility}
                            >
                                <Minus size={12} />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent className="bg-background border border-border">
                            Hide window
                        </TooltipContent>
                    </Tooltip>
                </div>
            </div>
            <div className="flex-1 overflow-auto min-h-0">
                <DomPortal element={panel.element} />
            </div>
        </div>
    );
}

type TilingNode =
    | { type: 'panel'; id: string }
    | {
          type: 'split';
          id: string;
          direction: 'vertical' | 'horizontal';
          children: TilingNode[];
      };

type DropPosition = 'top' | 'bottom' | 'left' | 'right';

// Where the user left their panels. Keyed by the id the plugin registered the
// panel under, so a panel that comes back - a hot reload, a plugin loaded again
// next session - lands where it was instead of floating at 100,100 again.
interface StoredPanelLayout {
    sidebarWidth?: number;
    tree?: TilingNode | null;
    panels?: Record<string, { pinned?: boolean; hidden?: boolean; x?: number; y?: number }>;
}

function readPanelLayout(): StoredPanelLayout {
    const stored = readJSON<StoredPanelLayout>(StorageKey.pluginPanels, {});
    return stored && typeof stored === 'object' ? stored : {};
}

function removeNodeFromTree(tree: TilingNode, id: string): TilingNode | null {
    if (tree.type === 'panel') return tree.id === id ? null : tree;
    const newChildren = tree.children
        .map((c) => removeNodeFromTree(c, id))
        .filter(Boolean) as TilingNode[];
    if (newChildren.length === 0) return null;
    if (newChildren.length === 1) return newChildren[0];
    return { ...tree, children: newChildren };
}

// The tree keeps a slot for every panel the user ever pinned, including ones
// that arent registered right now, so it survives a reload. Rendering uses a
// copy with those dropped - a node whose panel is missing would otherwise take
// up an empty column of the sidebar.
function pruneTree(tree: TilingNode | null, keep: Set<string>): TilingNode | null {
    if (!tree) return null;
    if (tree.type === 'panel') return keep.has(tree.id) ? tree : null;
    const children = tree.children
        .map((c) => pruneTree(c, keep))
        .filter(Boolean) as TilingNode[];
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { ...tree, children };
}

function treeHas(tree: TilingNode | null, id: string): boolean {
    if (!tree) return false;
    if (tree.type === 'panel') return tree.id === id;
    return tree.children.some((c) => treeHas(c, id));
}

function addNodeToTree(tree: TilingNode | null, id: string): TilingNode {
    if (!tree) return { type: 'panel', id };
    const direction =
        tree.type === 'split' && tree.direction === 'vertical' ? 'horizontal' : 'vertical';
    return { type: 'split', id: nanoid(), direction, children: [tree, { type: 'panel', id }] };
}

function insertNodeIntoTree(
    tree: TilingNode,
    draggedId: string,
    targetId: string,
    pos: DropPosition,
): TilingNode {
    if (tree.type === 'panel') {
        if (tree.id === targetId) {
            const isVertical = pos === 'top' || pos === 'bottom';
            const newPanel: TilingNode = { type: 'panel', id: draggedId };
            const children =
                pos === 'top' || pos === 'left' ? [newPanel, tree] : [tree, newPanel];
            return {
                type: 'split',
                id: nanoid(),
                direction: isVertical ? 'vertical' : 'horizontal',
                children,
            };
        }
        return tree;
    }
    return {
        ...tree,
        children: tree.children.map((c) => insertNodeIntoTree(c, draggedId, targetId, pos)),
    };
}

function moveNodeInTree(
    tree: TilingNode,
    draggedId: string,
    targetId: string,
    pos: DropPosition,
): TilingNode | null {
    if (draggedId === targetId) return tree;
    const prunedTree = removeNodeFromTree(tree, draggedId);
    if (!prunedTree) return { type: 'panel', id: draggedId };
    return insertNodeIntoTree(prunedTree, draggedId, targetId, pos);
}

function PanelDropZones({
    targetId,
    isDragging,
    onDropPosition,
    children,
}: {
    targetId: string;
    isDragging: boolean;
    onDropPosition: (draggedId: string, targetId: string, pos: DropPosition) => void;
    children: React.ReactNode;
}) {
    const [activeZone, setActiveZone] = React.useState<DropPosition | null>(null);

    const handleDrop = (e: React.DragEvent, pos: DropPosition) => {
        e.preventDefault();
        e.stopPropagation();
        setActiveZone(null);
        const draggedId = e.dataTransfer.getData('text/plain');
        if (draggedId && draggedId !== targetId) {
            onDropPosition(draggedId, targetId, pos);
        }
    };

    const zoneClass =
        'absolute z-50 opacity-0 transition-all duration-200 border-blue-500 pointer-events-auto';

    return (
        <div className="relative flex-1 flex flex-col min-h-0 min-w-0 group">
            {children}

            {isDragging && (
                <div className="absolute inset-0 pointer-events-none z-50">
                    {(['top', 'bottom', 'left', 'right'] as DropPosition[]).map((pos) => {
                        const isOver = activeZone === pos;
                        const activeBorderClass = {
                            top: 'border-t-4',
                            bottom: 'border-b-4',
                            left: 'border-l-4',
                            right: 'border-r-4',
                        }[pos];
                        return (
                            <div
                                key={pos}
                                className={cn(
                                    zoneClass,
                                    pos === 'left' && 'top-0 bottom-0 left-0 w-[45%]',
                                    pos === 'right' && 'top-0 bottom-0 right-0 w-[45%]',
                                    pos === 'top' && 'top-0 left-0 right-0 h-[30%] z-[51]',
                                    pos === 'bottom' &&
                                        'bottom-0 left-0 right-0 h-[30%] z-[51]',
                                    isOver && 'opacity-100 bg-blue-500/20',
                                    isOver && activeBorderClass,
                                )}
                                onDragLeave={() => setActiveZone(null)}
                                onDragOver={(e) => {
                                    if (activeZone !== pos) setActiveZone(pos);
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'move';
                                }}
                                onDrop={(e) => handleDrop(e, pos)}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function RenderTilingTree({
    node,
    panels,
    onTogglePin,
    onToggleVisibility,
    onMovePanel,
    chart,
    isDragging,
    setIsDragging,
}: {
    node: TilingNode;
    panels: PanelEntry[];
    onTogglePin: (id: string) => void;
    onToggleVisibility: (id: string) => void;
    onMovePanel: (draggedId: string, targetId: string, pos: DropPosition) => void;
    chart: DepthChart;
    isDragging: boolean;
    setIsDragging: (val: boolean) => void;
}) {
    if (node.type === 'panel') {
        const p = panels.find((p) => p.id === node.id);
        if (!p) return null;
        return (
            <PanelDropZones targetId={p.id} onDropPosition={onMovePanel} isDragging={isDragging}>
                <PanelShell
                    panel={p}
                    pinned
                    onTogglePin={() => onTogglePin(p.id)}
                    onToggleVisibility={() => {
                        onToggleVisibility(p.id);
                        chart.setPanelVisible(p.id, !p.visible);
                    }}
                    onDragStart={() => setIsDragging(true)}
                    onDragEnd={() => setIsDragging(false)}
                />
            </PanelDropZones>
        );
    }

    return (
        <ResizablePanelGroup
            direction={node.direction}
            className="flex flex-1 min-h-0 min-w-0 w-full h-full"
        >
            {node.children.map((child, idx) => {
                const childKey = child.type === 'panel' ? child.id : `split-${idx}`;
                return (
                    <React.Fragment key={childKey}>
                        <ResizablePanel
                            id={child.id}
                            order={idx}
                            defaultSize={Math.round(100 / node.children.length)}
                            minSize={10}
                            className="flex flex-col min-h-0 min-w-0 relative"
                        >
                            <RenderTilingTree
                                node={child}
                                panels={panels}
                                onTogglePin={onTogglePin}
                                onToggleVisibility={onToggleVisibility}
                                onMovePanel={onMovePanel}
                                chart={chart}
                                isDragging={isDragging}
                                setIsDragging={setIsDragging}
                            />
                        </ResizablePanel>
                        {idx < node.children.length - 1 && <ResizableHandle />}
                    </React.Fragment>
                );
            })}
        </ResizablePanelGroup>
    );
}

const SIDEBAR_MIN_PX = 180;
const SIDEBAR_DEFAULT_PX = 280;
const SIDEBAR_MAX_PX = 600;

export function PluginFixedPanelHost({
    eventBus,
    chart,
    onFixedPanelsChange,
    override,
}: {
    eventBus: TypedEventBus;
    chart: DepthChart;
    onFixedPanelsChange: (hasFixed: boolean) => void;
    override: boolean;
}) {
    const storedLayout = useRef(readPanelLayout()).current;

    const [isDraggingPanel, setIsDraggingPanel] = useState(false);
    const [panels, setPanels] = useState<PanelEntry[]>([]);
    const [pinned, setPinned] = useState<Set<string>>(
        () =>
            new Set(
                Object.entries(storedLayout.panels ?? {})
                    .filter(([, s]) => s.pinned)
                    .map(([id]) => id),
            ),
    );
    const [layoutTree, setLayoutTree] = useState<TilingNode | null>(storedLayout.tree ?? null);
    const [floatPos, setFloatPos] = useState<Map<string, { x: number; y: number }>>(
        () =>
            new Map(
                Object.entries(storedLayout.panels ?? {})
                    .filter(([, s]) => typeof s.x === 'number' && typeof s.y === 'number')
                    .map(([id, s]) => [id, { x: s.x!, y: s.y! }]),
            ),
    );
    const [sidebarWidth, setSidebarWidth] = useState(
        storedLayout.sidebarWidth ?? SIDEBAR_DEFAULT_PX,
    );
    const isDraggingSidebar = useRef(false);

    const [panelHeights, setPanelHeights] = useState(new Map<string, number>());
    const [panelZIndexes, setPanelZIndexes] = useState(new Map<string, number>());
    const panelRefs = useRef(new Map<string, HTMLDivElement | null>());

    const handleMovePanel = useCallback(
        (draggedId: string, targetId: string, pos: DropPosition) => {
            setIsDraggingPanel(false);
            setLayoutTree((currentTree) => {
                if (!currentTree) return null;
                return moveNodeInTree(currentTree, draggedId, targetId, pos);
            });
        },
        [],
    );

    useEffect(() => {
        if (!isDraggingPanel) return;
        const handleGlobalDragEnd = () => setIsDraggingPanel(false);
        window.addEventListener('dragend', handleGlobalDragEnd);
        window.addEventListener('mouseup', handleGlobalDragEnd);
        return () => {
            window.removeEventListener('dragend', handleGlobalDragEnd);
            window.removeEventListener('mouseup', handleGlobalDragEnd);
        };
    }, [isDraggingPanel]);

    // a panel the user minimised comes back minimised, whatever the plugin
    // passed to registerPanel
    const wasHidden = useCallback(
        (id: string) => storedLayout.panels?.[id]?.hidden === true,
        [storedLayout],
    );

    useEffect(() => {
        const reg = chart.getPanelRegistry();
        if (reg.size > 0) {
            for (const [id, { visible }] of reg.entries()) {
                if (visible && wasHidden(id)) chart.setPanelVisible(id, false);
            }
            setPanels(
                [...reg.entries()].map(([id, { element, title, visible }]) => ({
                    id,
                    title,
                    element,
                    visible: wasHidden(id) ? false : visible,
                })),
            );
        }

        const unsubs = [
            eventBus.on('plugin:panel-added', ({ id, title, visible }) => {
                const element = chart.getPanelRegistry().get(id)?.element;
                if (!element) return;
                // the plugin registers its panel visible every time, so a panel
                // the user minimised has to be put back the way they left it on
                // the chart, not just in this component - otherwise it renders
                // nowhere and the windows dropdown, which reads the registry,
                // doesnt list it either
                if (visible && wasHidden(id)) chart.setPanelVisible(id, false);
                setPanels((prev) => {
                    const idx = prev.findIndex((p) => p.id === id);
                    if (idx !== -1) {
                        const next = [...prev];
                        // a re-register (hot reload) keeps whatever the user set
                        next[idx] = { id, title, element, visible: prev[idx].visible };
                        return next;
                    }
                    return [...prev, { id, title, element, visible: wasHidden(id) ? false : visible }];
                });
            }),
            // only the live entry goes. pinning, position and the tiling slot are
            // the user's arrangement and outlive the panel, so an unloaded or
            // reloading plugin doesnt cost them their layout
            eventBus.on('plugin:panel-removed', ({ id }) => {
                setPanels((prev) => prev.filter((p) => p.id !== id));
            }),
            eventBus.on('plugin:panel-toggle-visibility', ({ id, visible }) => {
                setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, visible } : p)));
            }),
        ];
        return () => unsubs.forEach((fn) => fn());
    }, [eventBus, chart]);

    // a panel restored as pinned needs a slot in the tree, otherwise it is
    // neither floating nor tiled and the user just cant see it
    useEffect(() => {
        for (const p of panels) {
            if (!pinned.has(p.id)) continue;
            setLayoutTree((curr) => (treeHas(curr, p.id) ? curr : addNodeToTree(curr, p.id)));
        }
    }, [panels, pinned]);

    const togglePin = (id: string) => {
        setPinned((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
                setLayoutTree((curr) => (curr ? removeNodeFromTree(curr, id) : null));
            } else {
                next.add(id);
                setLayoutTree((curr) => addNodeToTree(curr, id));
            }
            return next;
        });
    };

    const toggleVisibility = (id: string) =>
        setPanels((prev) =>
            prev.map((panel) => (panel.id === id ? { ...panel, visible: !panel.visible } : panel)),
        );

    const fixedPanels = panels.filter((p) => pinned.has(p.id) && p.visible);

    useEffect(() => {
        onFixedPanelsChange(fixedPanels.length > 0);
    }, [fixedPanels.length]);

    // debounced: dragging a floating panel moves it every mousemove, and none of
    // those frames are worth a localStorage write of their own
    useEffect(() => {
        const timer = setTimeout(() => {
            const stored = readPanelLayout();
            const entries = { ...stored.panels };
            const ids = new Set([
                ...Object.keys(entries),
                ...pinned,
                ...floatPos.keys(),
                ...panels.map((p) => p.id),
            ]);
            for (const id of ids) {
                const live = panels.find((p) => p.id === id);
                const pos = floatPos.get(id);
                entries[id] = {
                    pinned: pinned.has(id),
                    hidden: live ? !live.visible : (entries[id]?.hidden ?? false),
                    ...(pos ? { x: Math.round(pos.x), y: Math.round(pos.y) } : {}),
                };
            }
            writeJSON(StorageKey.pluginPanels, {
                sidebarWidth,
                tree: layoutTree,
                panels: entries,
            } satisfies StoredPanelLayout);
        }, 400);
        return () => clearTimeout(timer);
    }, [pinned, floatPos, layoutTree, sidebarWidth, panels]);

    const startSidebarResize = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            isDraggingSidebar.current = true;
            const startX = e.clientX;
            const startW = sidebarWidth;
            const move = (ev: MouseEvent) => {
                const delta = startX - ev.clientX;
                const next = Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, startW + delta));
                setSidebarWidth(next);
            };
            const up = () => {
                isDraggingSidebar.current = false;
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        },
        [sidebarWidth],
    );

    const startDrag = (id: string, e: React.MouseEvent) => {
        e.preventDefault();
        const highestZIndex = Math.max(...[...panelZIndexes.values()], 50);
        setPanelZIndexes((prev) => {
            const next = new Map(prev);
            next.set(id, highestZIndex + 1);
            return next;
        });
        const current = floatPos.get(id) ?? { x: 100, y: 100 };
        let { x, y } = current;
        const ox = e.clientX - x,
            oy = e.clientY - y;
        const move = (ev: MouseEvent) => {
            x = ev.clientX - ox;
            y = ev.clientY - oy;
            setFloatPos((prev) => new Map(prev).set(id, { x, y }));
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    };

    const floatingPanels = panels.filter((p) => !pinned.has(p.id) && p.visible);
    const renderTree = pruneTree(layoutTree, new Set(fixedPanels.map((p) => p.id)));

    return (
        <>
            {!override && fixedPanels.length === 0 && (
                <div
                    className="flex flex-row shrink-0 border-l border-border bg-background overflow-hidden"
                    style={{ width: sidebarWidth }}
                >
                    <div
                        className="w-1 shrink-0 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 transition-colors"
                        style={{ zIndex: 10 }}
                        onMouseDown={startSidebarResize}
                    />
                    <div className="flex w-full h-full items-center justify-center text-xs text-muted-foreground">
                        No pinned
                        <HoverCard openDelay={0}>
                            <HoverCardTrigger className='underline ml-1'>
                                panels
                            </HoverCardTrigger>
                            <HoverCardContent className='p-2'>
                                Panels are windows that <a href="https://docs.christtrade.com/depth/scripted/types#extension" target='_blank' className='underline inline'>extension type plugins</a> can spawn
                            </HoverCardContent>
                        </HoverCard>
                    </div>
                </div>
            )}
            {fixedPanels.length > 0 && renderTree && !override && (
                <div
                    className="flex flex-row shrink-0 border-l border-border bg-background overflow-hidden"
                    style={{ width: sidebarWidth }}
                >
                    <div
                        className="w-1 shrink-0 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 transition-colors"
                        style={{ zIndex: 10 }}
                        onMouseDown={startSidebarResize}
                    />
                    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                        <RenderTilingTree
                            node={renderTree}
                            panels={fixedPanels}
                            onTogglePin={togglePin}
                            onToggleVisibility={toggleVisibility}
                            onMovePanel={handleMovePanel}
                            chart={chart}
                            isDragging={isDraggingPanel}
                            setIsDragging={setIsDraggingPanel}
                        />
                    </div>
                </div>
            )}
            {floatingPanels.map((p) => {
                const pos = floatPos.get(p.id) ?? { x: 100, y: 100 };
                const panelHeight = panelHeights.get(p.id) ?? 200;
                const z = panelZIndexes.get(p.id) ?? 50;

                return (
                    <div
                        key={p.id}
                        style={{
                            position: 'fixed',
                            left: Math.max(Math.min(pos.x, window.innerWidth - 12 - 280), 12),
                            top: Math.max(
                                Math.min(pos.y, window.innerHeight - 12 - panelHeight),
                                12,
                            ),
                            width: 280,
                            zIndex: z,
                        }}
                        className="flex flex-col rounded-lg border border-border bg-background shadow-xl overflow-hidden"
                        ref={(el) => {
                            if (el) {
                                panelRefs.current.set(p.id, el);
                                const h = el.clientHeight;
                                const prevH = panelHeights.get(p.id);
                                if (prevH !== h) {
                                    setPanelHeights((prev) => {
                                        const next = new Map(prev);
                                        next.set(p.id, h);
                                        return next;
                                    });
                                }
                            } else {
                                panelRefs.current.delete(p.id);
                            }
                        }}
                    >
                        <PanelShell
                            panel={p}
                            pinned={false}
                            onTogglePin={() => togglePin(p.id)}
                            onToggleVisibility={() => {
                                toggleVisibility(p.id);
                                chart.setPanelVisible(p.id, !p.visible);
                            }}
                            onDragHeader={(e) => startDrag(p.id, e)}
                        />
                    </div>
                );
            })}
        </>
    );
}
