import { useEffect, useRef, useState } from 'react';
import { IconClose, IconFile, IconPlus } from '@/components/icons';
import {
  ATTACHMENT_ACCEPT,
  attachmentImageUrl,
  attachmentTypeLabel,
  formatSize,
  type Attachment,
  type DraftAttachment,
} from '@/lib/attachments';
import { t } from '@/lib/i18n';
import type { Settings } from '@/lib/settings';

/** A card as shown anywhere: a draft card, or a sent attachment wrapped as a ready one */
export type CardItem = Pick<DraftAttachment, 'key' | 'name' | 'format' | 'status' | 'previewUrl' | 'attachment'>;

export function sentCards(list: Attachment[]): CardItem[] {
  return list.map((a) => ({ key: a.id, name: a.name, format: a.format, status: 'ready', attachment: a }));
}

const BADGES: Partial<Record<CardItem['format'], string>> = { pdf: 'PDF', docx: 'DOC', xlsx: 'XLS', pptx: 'PPT' };

function badgeText(item: CardItem): string | null {
  if (item.format === 'text') {
    const ext = /\.([a-z0-9]{1,4})$/i.exec(item.name)?.[1];
    return ext ? ext.toUpperCase() : 'TXT';
  }
  return BADGES[item.format] ?? null;
}

export interface PreviewTarget {
  url: string;
  name: string;
}

interface CardProps {
  item: CardItem;
  settings: Settings | null;
  onRemove?: (key: string) => void;
  onPreview?: (target: PreviewTarget) => void;
}

function AttachmentCard({ item, settings, onRemove, onPreview }: CardProps) {
  const isImage = item.format === 'image';
  const id = item.attachment?.id;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (!isImage || item.previewUrl || !id || !settings) return;
    let alive = true;
    attachmentImageUrl(settings, id).then(
      (url) => alive && setLoaded(url),
      () => alive && setBroken(true),
    );
    return () => {
      alive = false;
    };
  }, [isImage, item.previewUrl, id, settings]);

  const url = isImage && !broken ? (item.previewUrl ?? loaded) : null;
  const uploading = item.status === 'uploading';
  const badge = badgeText(item);
  const size = item.attachment?.size;
  const sub = uploading
    ? t('attachment.uploading')
    : size != null
      ? `${attachmentTypeLabel(item.format)} · ${formatSize(size)}`
      : attachmentTypeLabel(item.format);

  const thumb = url ? (
    <img src={url} alt="" draggable={false} onError={() => setBroken(true)} />
  ) : (
    <span className={`att-icon att-${item.format}`}>
      {badge ? <span className="att-badge">{badge}</span> : <IconFile />}
    </span>
  );

  return (
    <div className={`att-card${uploading ? ' uploading' : ''}`} title={item.name}>
      {url && onPreview && !uploading ? (
        <button
          type="button"
          className="att-thumb"
          title={t('attachment.preview')}
          aria-label={`${t('attachment.preview')}: ${item.name}`}
          onClick={() => onPreview({ url, name: item.name })}
        >
          {thumb}
        </button>
      ) : (
        <span className="att-thumb">
          {thumb}
          {uploading && <span className="att-spin" aria-hidden="true" />}
        </span>
      )}
      <span className="att-meta">
        <span className="att-name">{item.name}</span>
        <span className="att-sub">{sub}</span>
      </span>
      {onRemove && (
        <button
          type="button"
          className="att-remove"
          title={t('attachment.remove')}
          aria-label={`${t('attachment.remove')}: ${item.name}`}
          onClick={() => onRemove(item.key)}
        >
          <IconClose />
        </button>
      )}
    </div>
  );
}

interface StripProps {
  items: CardItem[];
  settings: Settings | null;
  className?: string;
  onRemove?: (key: string) => void;
  onPreview?: (target: PreviewTarget) => void;
}

export function AttachmentStrip({ items, settings, className, onRemove, onPreview }: StripProps) {
  if (!items.length) return null;
  return (
    <div className={className ? `att-strip ${className}` : 'att-strip'}>
      {items.map((item) => (
        <AttachmentCard key={item.key} item={item} settings={settings} onRemove={onRemove} onPreview={onPreview} />
      ))}
    </div>
  );
}

interface AttachButtonProps {
  disabled?: boolean;
  className?: string;
  onFiles: (files: File[]) => void;
}

/** "+" button backed by a hidden file input */
export function AttachButton({ disabled, className, onFiles }: AttachButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        className={className ? `attach ${className}` : 'attach'}
        disabled={disabled}
        title={t('composer.attach')}
        aria-label={t('composer.attach')}
        onClick={() => inputRef.current?.click()}
      >
        <IconPlus />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={ATTACHMENT_ACCEPT}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Reset so picking the same file again still fires change
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** Full-size image preview; a click anywhere or Escape closes it */
export function ImageLightbox({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    // Capture phase: Escape must close the preview, not also cancel an inline edit underneath it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={target.name} onClick={onClose}>
      <img src={target.url} alt={target.name} />
      <button
        ref={closeRef}
        type="button"
        className="lightbox-close"
        title={t('attachment.previewClose')}
        aria-label={t('attachment.previewClose')}
        onClick={onClose}
      >
        <IconClose />
      </button>
    </div>
  );
}
