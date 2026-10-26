import { createSignal, type JSX } from 'solid-js';

/**
 * The panel beside an editor on wide screens (routes/Document.tsx,
 * routes/Homework.tsx): a card as wide as it is dragged at its left edge.
 * It slides in from the right edge as it opens, the text making room as it
 * comes, and back out when it closes: the card rides the panel's left edge
 * and is cut off at its right one. It stays mounted while closed, so what
 * it shows keeps its place.
 */

/** The drag handle and its margins, beside the card. */
const HANDLE = 32;

export function SidePanel(props: {
  open: boolean;
  width: number;
  onWidth: (width: number) => void;
  /** Dragging ended: remember the width. */
  onResized: () => void;
  label: string;
  children: JSX.Element;
}) {
  const [dragging, setDragging] = createSignal(false);
  let start: { x: number; w: number } | null = null;
  const total = () => props.width + HANDLE;
  const motion = 'motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.25,1,0.5,1)]';
  return (
    <div
      class={`sticky top-3 flex h-[calc(100dvh-7.5rem)] shrink-0 motion-safe:transition-[width] ${motion}`}
      // Cut off only at the right, where the card comes from; its shadow stays elsewhere.
      style={{ width: props.open ? `${total()}px` : '0px', 'clip-path': 'inset(-80px 0 -80px -80px)', ...(dragging() ? { 'transition-duration': '0s' } : {}) }}
      inert={props.open ? undefined : true}
    >
      <div class="flex h-full shrink-0" style={{ width: `${total()}px` }}>
        <div
          class="mx-3 h-full w-2 shrink-0 cursor-col-resize touch-none rounded-full transition-colors hover:bg-line"
          title="Drag to resize"
          onPointerDown={(e) => {
            start = { x: e.clientX, w: props.width };
            setDragging(true);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => start && props.onWidth(start.w - (e.clientX - start.x))}
          onPointerUp={() => {
            start = null;
            setDragging(false);
            props.onResized();
          }}
        />
        <aside
          class="flex h-full shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-frame"
          style={{ width: `${props.width}px` }}
          aria-label={props.label}
        >
          {props.children}
        </aside>
      </div>
    </div>
  );
}
