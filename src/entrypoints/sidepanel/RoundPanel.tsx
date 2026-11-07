import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '@/lib/i18n';

/** 正文出现前那句「正在思考」：出现时淡入，正文一到淡出并塌陷 */
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

/** 思考/工具折叠块：流式时展开，结束后自动收起；流式期间用户手动收起不会被下一批 token 顶开 */
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
