import { useState, type ReactNode } from 'react';

export function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** External link. Opens in a new tab. */
export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="wrap-anywhere text-accent underline decoration-dotted underline-offset-4 hover:decoration-solid"
    >
      {children}
    </a>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded bg-code px-1 py-0.5 font-mono text-[0.85em] wrap-anywhere">{children}</code>;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

const PILL: Record<Tone, string> = {
  ok: 'border-ok/40 bg-ok/10 text-ok',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  bad: 'border-bad/40 bg-bad/10 text-bad',
  muted: 'border-line bg-surface-2 text-muted',
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${PILL[tone]}`}>{children}</span>
  );
}

const NOTICE: Record<Tone, string> = {
  ok: 'border-ok/40 bg-ok/10',
  warn: 'border-warn/40 bg-warn/10',
  bad: 'border-bad/40 bg-bad/10',
  muted: 'border-line bg-surface-2',
};

export function Notice({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <p className={`mb-3 rounded-lg border px-3 py-2 text-sm ${NOTICE[tone]}`}>{children}</p>;
}

export const BUTTON =
  'rounded-md border border-line bg-surface-2 px-3 py-1.5 text-sm font-medium hover:bg-line disabled:cursor-not-allowed disabled:opacity-50';

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setDone(true);
        window.setTimeout(() => setDone(false), 1500);
      })
      .catch(() => setDone(false));
  };
  return (
    <button type="button" onClick={copy} className={BUTTON}>
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}
