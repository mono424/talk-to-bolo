import { createContext, createSignal, onCleanup, Show, useContext, type ParentProps } from 'solid-js';
import { Portal } from 'solid-js/web';

/**
 * Page controls outside the page: in the app's top bar next to the account
 * menu, and at the top of the recent sessions column. The layout renders the
 * slots; a page fills them with <HeaderActions> and <SideActions>, which
 * disappear with the page.
 */
type Slot = { el: () => HTMLElement | undefined; set: (el: HTMLElement | undefined) => void };
const SlotContext = createContext<{ header: Slot; side: Slot }>();

function createSlot(): Slot {
  const [el, set] = createSignal<HTMLElement>();
  return { el, set };
}

export function HeaderSlotProvider(props: ParentProps) {
  return <SlotContext.Provider value={{ header: createSlot(), side: createSlot() }}>{props.children}</SlotContext.Provider>;
}

function Outlet(props: { slot?: Slot; class?: string }) {
  onCleanup(() => props.slot?.set(undefined));
  return <div ref={(el) => props.slot?.set(el)} class={props.class} />;
}

function Fill(props: ParentProps<{ slot?: Slot }>) {
  return (
    <Show when={props.slot?.el()}>
      {(mount) => (
        // The portal's wrapper must not break the slot's flex row.
        <Portal mount={mount()} ref={(el) => (el.style.display = 'contents')}>
          {props.children}
        </Portal>
      )}
    </Show>
  );
}

export function HeaderSlot(props: { class?: string }) {
  return <Outlet slot={useContext(SlotContext)?.header} class={props.class} />;
}

export function HeaderActions(props: ParentProps) {
  return <Fill slot={useContext(SlotContext)?.header}>{props.children}</Fill>;
}

/** Top of the recent sessions column, shown on wide windows only. */
export function SideSlot(props: { class?: string }) {
  return <Outlet slot={useContext(SlotContext)?.side} class={props.class} />;
}

export function SideActions(props: ParentProps) {
  return <Fill slot={useContext(SlotContext)?.side}>{props.children}</Fill>;
}
