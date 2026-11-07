/**
 * 按钮用的图标。统一 16×16 视口、`currentColor`，尺寸由 CSS 的 `.icon` 控制。
 * 都带 aria-hidden：可访问名称由按钮自己的 aria-label 提供，避免读屏念出两遍。
 */

type Props = { className?: string };

const base = {
  className: 'icon',
  viewBox: '0 0 16 16',
  width: 16,
  height: 16,
  'aria-hidden': true,
  focusable: false,
} as const;

/** 展开三角：收起时指向右，展开后由 CSS 转 90° 朝下 */
export function IconChevron({ open }: { open?: boolean }) {
  return (
    <svg {...base} className={`icon chevron${open ? ' open' : ''}`}>
      <path d="M6 4.2 10.4 8 6 11.8Z" fill="currentColor" />
    </svg>
  );
}

/** 放大的左引号 */
export function IconQuote(_props: Props) {
  return (
    <svg {...base}>
      <path
        d="M7.1 3.4c-2.3 1-3.6 3-3.6 5.6V12h4.2V7.9H5.3c.1-1.5.8-2.6 2.1-3.4zM13.6 3.4c-2.3 1-3.6 3-3.6 5.6V12h4.2V7.9h-2.4c.1-1.5.8-2.6 2.1-3.4z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 发送：向上的箭头 */
export function IconSend(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.8} fill="none">
      <path d="M8 13V3.6" strokeLinecap="round" />
      <path d="M4.2 7.2 8 3.4l3.8 3.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 停止：圆角矩形 */
export function IconStop(_props: Props) {
  return (
    <svg {...base}>
      <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="2.2" fill="currentColor" />
    </svg>
  );
}

/** 复制：两个叠起来的圆角方块 */
export function IconCopy(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.4} fill="none">
      <rect x="2.4" y="2.4" width="8" height="8" rx="2" />
      <path d="M5.8 13.6h5.8a2 2 0 0 0 2-2V5.8" strokeLinecap="round" />
    </svg>
  );
}

/** 重新生成：环形箭头 */
export function IconReload(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.4} fill="none">
      <path d="M13 8a5 5 0 1 1-1.6-3.7" strokeLinecap="round" />
      <path d="M13.2 2.4v2.9h-2.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 已完成（复制成功时的短暂反馈） */
export function IconCheck(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.8} fill="none">
      <path d="M3 8.4 6.4 11.8 13 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
