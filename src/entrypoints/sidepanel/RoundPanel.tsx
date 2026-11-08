import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '@/lib/i18n';

/** "Thinking" placeholder before answer text: fades in, then fades out and collapses once text arrives */
export function ThinkingFade({ show }: { show: boolean }) {
  const [mounted, setMounted] = useState(show);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (show) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(timer);
  }, [show, mounted]);

  if (!mounted) return null;
  return <div className={`thinking${closing ? ' out' : ''}`}>{t('answer.thinking')}</div>;
}

/** Thinking/tool block: open while streaming, auto-collapsed after; a manual collapse is not undone by later tokens */
export function RoundPanel({ active, summary, children }: { active: boolean; summary: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const wasActive = useRef(active);

  useEffect(() => {
    if (wasActive.current === active) return;
    wasActive.current = active;
    if (ref.current) ref.current.open = active;
  }, [active]);

  return (
    <details ref={ref} className="round" open={active}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
