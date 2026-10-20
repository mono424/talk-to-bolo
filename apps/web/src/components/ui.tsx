import type { JSX } from 'solid-js';
import { splitProps } from 'solid-js';

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'quiet' | 'danger' | 'call';
  size?: 'sm' | 'md' | 'lg';
};

const VARIANTS = {
  primary: 'bg-ink text-sheet hover:bg-ink-hover disabled:opacity-50',
  quiet: 'text-graphite hover:bg-rule-soft border border-rule disabled:opacity-50',
  danger: 'bg-margin text-white hover:brightness-95 disabled:opacity-50',
  call: 'bg-highlighter text-highlighter-ink hover:brightness-95 disabled:opacity-60 font-bold',
} as const;

const SIZES = {
  sm: 'text-sm px-3 py-1.5 rounded-md gap-1.5',
  md: 'text-[15px] px-4 py-2 rounded-lg gap-2',
  lg: 'text-base px-6 py-3 rounded-full gap-2.5',
} as const;

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ['variant', 'size', 'class', 'type']);
  return (
    <button
      type={local.type ?? 'button'}
      class={`inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[local.variant ?? 'primary']} ${SIZES[local.size ?? 'md']} ${local.class ?? ''}`}
      {...rest}
    />
  );
}

export function Field(props: { label: string; hint?: string; children: JSX.Element; class?: string }) {
  return (
    <label class={`block ${props.class ?? ''}`}>
      <span class="block text-sm font-medium mb-1.5">{props.label}</span>
      {props.children}
      {props.hint && <span class="block text-xs text-pencil mt-1">{props.hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-rule bg-sheet px-3 py-2 text-[15px] placeholder:text-pencil/70 focus:border-ink focus:outline-none';

export function StatusBadge(props: { status: string; detail?: string | null }) {
  const tone = () =>
    ({
      ready: 'text-ok',
      failed: 'text-margin',
      processing: 'text-ink',
      pending: 'text-pencil',
    })[props.status] ?? 'text-pencil';
  const label = () =>
    ({
      ready: 'Ready for calls',
      failed: 'Processing failed',
      processing: props.detail || 'Processing',
      pending: 'Waiting to process',
    })[props.status] ?? props.status;
  return (
    <span class={`inline-flex items-center gap-1.5 text-xs ${tone()}`}>
      <span
        class={`h-1.5 w-1.5 rounded-full bg-current ${props.status === 'processing' ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {label()}
    </span>
  );
}

export function formatDate(v: unknown, withTime = false): string {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}
