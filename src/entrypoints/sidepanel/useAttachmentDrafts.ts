import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  discardAttachment,
  guessFormat,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  prepareImage,
  rememberImageUrl,
  uploadAttachment,
  type Attachment,
  type DraftAttachment,
} from '@/lib/attachments';
import { t } from '@/lib/i18n';
import type { Settings } from '@/lib/settings';

let nextKey = 0;

export interface AttachmentDrafts {
  items: DraftAttachment[];
  uploading: boolean;
  add: (files: File[]) => void;
  remove: (key: string) => void;
  /** Replace the cards with existing attachments; `owned` ones are deleted on the backend when removed */
  reset: (list: Attachment[], owned: boolean) => void;
  /** Drop every card and delete the uploads this draft made (cancel / abandon) */
  discardNew: () => void;
  /** Hand the uploaded attachments to a send and clear the cards without deleting anything */
  take: () => Attachment[];
  hasItems: () => boolean;
}

function toCard(a: Attachment, owned: boolean): DraftAttachment {
  return { key: `att${++nextKey}`, name: a.name, format: a.format, status: 'ready', attachment: a, owned };
}

/** A sent image keeps its object URL in the shared cache (thumbnail + preview); anything else is freed */
function release(item: DraftAttachment): void {
  if (item.previewUrl && !item.attachment) URL.revokeObjectURL(item.previewUrl);
}

/**
 * Cards of one draft (the composer, or the inline question editor). Files upload as soon as they are
 * added, so Send only carries ids. Every function is stable; the items ref is the source of truth so
 * async upload callbacks never act on a stale list.
 */
export function useAttachmentDrafts(settings: Settings | null, onError: (message: string) => void): AttachmentDrafts {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const itemsRef = useRef<DraftAttachment[]>([]);
  const settingsRef = useRef(settings);
  const onErrorRef = useRef(onError);
  const uploads = useRef(new Map<string, AbortController>());

  useEffect(() => {
    settingsRef.current = settings;
    onErrorRef.current = onError;
  }, [settings, onError]);

  useEffect(() => {
    const pending = uploads.current;
    return () => {
      for (const ctrl of pending.values()) ctrl.abort();
    };
  }, []);

  const commit = useCallback((next: DraftAttachment[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const upload = useCallback(
    async (key: string, file: File, s: Settings) => {
      const ctrl = new AbortController();
      uploads.current.set(key, ctrl);
      try {
        const body = guessFormat(file.name, file.type) === 'image' ? await prepareImage(file) : file;
        if (ctrl.signal.aborted) return;
        if (body.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(t('error.attachment.too_large', { limitMb: MAX_ATTACHMENT_BYTES / 1024 / 1024 }));
        }
        const attachment = await uploadAttachment(s, body, file.name, ctrl.signal);
        const item = itemsRef.current.find((it) => it.key === key);
        if (!item) {
          discardAttachment(s, attachment.id);
          return;
        }
        if (item.previewUrl && attachment.kind === 'image') rememberImageUrl(attachment.id, item.previewUrl);
        else if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        commit(
          itemsRef.current.map((it) =>
            it.key === key
              ? {
                  ...it,
                  status: 'ready',
                  name: attachment.name,
                  format: attachment.format,
                  attachment,
                  previewUrl: attachment.kind === 'image' ? it.previewUrl : undefined,
                }
              : it,
          ),
        );
      } catch (err) {
        if (ctrl.signal.aborted || (err as Error).name === 'AbortError') return;
        const item = itemsRef.current.find((it) => it.key === key);
        if (!item) return;
        release(item);
        commit(itemsRef.current.filter((it) => it.key !== key));
        onErrorRef.current(
          t('attachment.uploadFailed', { name: file.name, message: err instanceof Error ? err.message : String(err) }),
        );
      } finally {
        uploads.current.delete(key);
      }
    },
    [commit],
  );

  const add = useCallback(
    (files: File[]) => {
      const s = settingsRef.current;
      if (!s || !files.length) return;
      const room = Math.max(0, MAX_ATTACHMENTS - itemsRef.current.length);
      if (files.length > room) onErrorRef.current(t('error.attachment.too_many', { max: MAX_ATTACHMENTS }));
      const accepted: Array<{ card: DraftAttachment; file: File }> = [];
      for (const file of files.slice(0, room)) {
        const format = guessFormat(file.name, file.type);
        // Images are checked after downscaling; everything else can be rejected before any upload.
        if (format !== 'image' && file.size > MAX_ATTACHMENT_BYTES) {
          onErrorRef.current(
            t('attachment.uploadFailed', {
              name: file.name,
              message: t('error.attachment.too_large', { limitMb: MAX_ATTACHMENT_BYTES / 1024 / 1024 }),
            }),
          );
          continue;
        }
        const card: DraftAttachment = {
          key: `att${++nextKey}`,
          name: file.name || t('attachment.type.file'),
          format,
          status: 'uploading',
          previewUrl: format === 'image' ? URL.createObjectURL(file) : undefined,
          owned: true,
        };
        accepted.push({ card, file });
      }
      if (!accepted.length) return;
      commit([...itemsRef.current, ...accepted.map((a) => a.card)]);
      for (const { card, file } of accepted) void upload(card.key, file, s);
    },
    [commit, upload],
  );

  const drop = useCallback(
    (item: DraftAttachment, deleteUpload: boolean) => {
      uploads.current.get(item.key)?.abort();
      const s = settingsRef.current;
      if (deleteUpload && item.owned && item.attachment && s) discardAttachment(s, item.attachment.id);
      release(item);
    },
    [],
  );

  const remove = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((it) => it.key === key);
      if (!item) return;
      drop(item, true);
      commit(itemsRef.current.filter((it) => it.key !== key));
    },
    [commit, drop],
  );

  const reset = useCallback(
    (list: Attachment[], owned: boolean) => {
      for (const item of itemsRef.current) drop(item, false);
      commit(list.map((a) => toCard(a, owned)));
    },
    [commit, drop],
  );

  const discardNew = useCallback(() => {
    if (!itemsRef.current.length) return;
    for (const item of itemsRef.current) drop(item, true);
    commit([]);
  }, [commit, drop]);

  const take = useCallback(() => {
    const ready: Attachment[] = [];
    for (const item of itemsRef.current) {
      if (item.status === 'ready' && item.attachment) ready.push(item.attachment);
      else drop(item, false);
    }
    commit([]);
    return ready;
  }, [commit, drop]);

  const hasItems = useCallback(() => itemsRef.current.length > 0, []);

  const uploading = items.some((it) => it.status === 'uploading');

  return useMemo(
    () => ({ items, uploading, add, remove, reset, discardNew, take, hasItems }),
    [items, uploading, add, remove, reset, discardNew, take, hasItems],
  );
}
