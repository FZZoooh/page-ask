import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from './messages';

interface ScrollRefs {
  list: React.RefObject<HTMLDivElement | null>;
  spacer: React.RefObject<HTMLDivElement | null>;
  lead: React.RefObject<HTMLDivElement | null>;
  latestUser: React.RefObject<HTMLDivElement | null>;
  editingUser: React.RefObject<HTMLDivElement | null>;
  listEnd: React.RefObject<HTMLDivElement | null>;
}

function createScrollController(refs: ScrollRefs, setShowScrollBtn: (show: boolean) => void) {
  const valueRef = <T,>(value: T) => ({ current: value });
  const scrollConversation = valueRef<string | null>(null);
  const spacerHeight = valueRef(0);
  const contentHeight = valueRef(0);
  const leadHeight = valueRef(0);
  const leadAnim = valueRef<number | null>(null);
  const centerNext = valueRef(false);
  const prepended = valueRef(false);
  const pendingConversation = valueRef(false);
  const internalScrollUntil = valueRef(0);
  const userScrollAt = valueRef(0);
  const centerLockTop = valueRef(0);
  const centerLockUntil = valueRef(0);
  const stickToBottom = valueRef(true);
  const scrollAnim = valueRef<{ frame: number; until: number } | null>(null);

  const cancelScrollAnim = () => {
    if (!scrollAnim.current) return;
    cancelAnimationFrame(scrollAnim.current.frame);
    scrollAnim.current = null;
  };

  const applySpacer = (px: number) => {
    const max = refs.list.current?.clientHeight ?? 0;
    const next = Math.max(0, Math.min(max, Math.round(px)));
    spacerHeight.current = next;
    if (refs.spacer.current) refs.spacer.current.style.height = `${next}px`;
  };

  const cancelLeadAnim = () => {
    if (leadAnim.current == null) return;
    cancelAnimationFrame(leadAnim.current);
    leadAnim.current = null;
  };

  const applyLead = (px: number) => {
    const max = refs.list.current?.clientHeight ?? 0;
    const next = Math.max(0, Math.min(max, Math.round(px)));
    leadHeight.current = next;
    if (refs.lead.current) refs.lead.current.style.height = `${next}px`;
  };

  const scrollTo = (el: HTMLElement, top: number) => {
    cancelScrollAnim();
    internalScrollUntil.current = performance.now() + 120;
    el.scrollTop = top;
  };

  const animateScrollTo = (el: HTMLElement, top: number) => {
    cancelScrollAnim();
    const from = el.scrollTop;
    const delta = top - from;
    const duration = 460;
    if (Math.abs(delta) < 2 || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      scrollTo(el, top);
      return;
    }
    const start = performance.now();
    internalScrollUntil.current = start + duration + 120;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      el.scrollTop = from + delta * eased;
      if (t < 1) {
        scrollAnim.current = { frame: requestAnimationFrame(tick), until: start + duration };
      } else {
        scrollAnim.current = null;
        internalScrollUntil.current = performance.now() + 120;
      }
    };
    scrollAnim.current = { frame: requestAnimationFrame(tick), until: start + duration };
  };

  const clearCenterLock = () => {
    centerLockUntil.current = 0;
  };

  const scrollToBottom = () => {
    const el = refs.list.current;
    if (!el) return;
    clearCenterLock();
    applySpacer(0);
    contentHeight.current = el.scrollHeight;
    stickToBottom.current = true;
    setShowScrollBtn(false);
    animateScrollTo(el, el.scrollHeight);
  };

  const refreshScrollBtn = (el: HTMLElement) => {
    const end = refs.listEnd.current;
    if (!end) return;
    const gap = end.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
    setShowScrollBtn(gap > 1);
  };

  const animateLeadTo = (el: HTMLElement, top: number) => {
    cancelLeadAnim();
    const from = leadHeight.current;
    if (Math.abs(top - from) < 2) {
      applyLead(top);
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      applyLead(top);
      contentHeight.current = el.scrollHeight - spacerHeight.current;
      return;
    }
    const duration = 460;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      applyLead(from + (top - from) * eased);
      contentHeight.current = el.scrollHeight - spacerHeight.current;
      if (t < 1) {
        leadAnim.current = requestAnimationFrame(tick);
      } else {
        leadAnim.current = null;
        applyLead(top);
        contentHeight.current = el.scrollHeight - spacerHeight.current;
      }
    };
    leadAnim.current = requestAnimationFrame(tick);
  };

  const reconcileGrowth = (el: HTMLElement) => {
    const height = el.scrollHeight - spacerHeight.current;
    const delta = height - contentHeight.current;
    contentHeight.current = height;
    if (delta > 0) {
      if (spacerHeight.current > 0) applySpacer(spacerHeight.current - delta);
    } else if (delta < 0 && !(stickToBottom.current && spacerHeight.current <= 0)) {
      applySpacer(spacerHeight.current - delta);
    }

    const now = performance.now();
    if (scrollAnim.current && now < scrollAnim.current.until) return;
    if (centerLockUntil.current > now) {
      const need = centerLockTop.current + el.clientHeight - el.scrollHeight;
      if (need > 0) applySpacer(spacerHeight.current + need);
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const want = Math.min(centerLockTop.current, maxTop);
      if (Math.abs(el.scrollTop - want) > 1) scrollTo(el, want);
      refreshScrollBtn(el);
      return;
    }

    if (stickToBottom.current && spacerHeight.current <= 0) scrollTo(el, el.scrollHeight);
    refreshScrollBtn(el);
  };

  const prepareSend = ({ center, editing, newConversation }: { center: boolean; editing: boolean; newConversation: boolean }) => {
    stickToBottom.current = false;
    setShowScrollBtn(false);
    centerNext.current = center;
    if (editing) {
      centerLockTop.current = refs.list.current?.scrollTop ?? 0;
      centerLockUntil.current = performance.now() + 30_000;
    }
    if (newConversation) pendingConversation.current = true;
  };

  const conversationAssigned = (conversationId: string) => {
    if (!pendingConversation.current) return;
    scrollConversation.current = conversationId;
    pendingConversation.current = false;
  };

  const reset = () => {
    cancelScrollAnim();
    pendingConversation.current = false;
    cancelLeadAnim();
    applyLead(0);
    applySpacer(0);
    contentHeight.current = 0;
    centerNext.current = false;
    clearCenterLock();
    stickToBottom.current = true;
    setShowScrollBtn(false);
  };

  const followBottom = () => {
    stickToBottom.current = true;
    setShowScrollBtn(false);
  };

  const preparePrepend = () => {
    cancelScrollAnim();
    prepended.current = true;
  };

  const restorePrepend = (previousHeight: number, previousTop: number) => {
    requestAnimationFrame(() => {
      const el = refs.list.current;
      if (!el) return;
      internalScrollUntil.current = performance.now() + 120;
      el.scrollTop = previousTop + (el.scrollHeight - previousHeight);
    });
  };

  const cancelPrepend = () => {
    prepended.current = false;
  };

  const revealEditing = () => {
    const el = refs.list.current;
    const row = refs.editingUser.current;
    if (!el || !row) return;
    cancelScrollAnim();
    stickToBottom.current = false;
    const listRect = el.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    let top = el.scrollTop + Math.max(0, rowRect.bottom - listRect.bottom);
    const need = top + el.clientHeight - el.scrollHeight;
    if (need > 0) applySpacer(spacerHeight.current + need);
    top = Math.min(top, Math.max(0, el.scrollHeight - el.clientHeight));
    scrollTo(el, top);
    refreshScrollBtn(el);
    contentHeight.current = el.scrollHeight - spacerHeight.current;
  };

  const noteUserScroll = () => {
    cancelScrollAnim();
    internalScrollUntil.current = 0;
    userScrollAt.current = performance.now();
    clearCenterLock();
  };

  const onScroll = () => {
    const el = refs.list.current;
    if (!el) return;
    const now = performance.now();
    if (scrollAnim.current && now < scrollAnim.current.until) return;
    if (centerLockUntil.current > now) {
      const need = centerLockTop.current + el.clientHeight - el.scrollHeight;
      if (need > 0) applySpacer(spacerHeight.current + need);
      const want = Math.min(centerLockTop.current, Math.max(0, el.scrollHeight - el.clientHeight));
      centerLockTop.current = want;
      if (Math.abs(el.scrollTop - want) > 1) {
        internalScrollUntil.current = now + 120;
        el.scrollTop = want;
      }
      return;
    }
    if (now < internalScrollUntil.current) return;
    if (now - userScrollAt.current > 400) return;

    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap > 1 && spacerHeight.current > 0) {
      applySpacer(spacerHeight.current - gap);
      stickToBottom.current = false;
      refreshScrollBtn(el);
      return;
    }
    if (gap <= 1 && spacerHeight.current <= 0) {
      stickToBottom.current = true;
    } else if (gap > 1) {
      stickToBottom.current = false;
    }
    refreshScrollBtn(el);
  };

  return {
    scrollConversation,
    spacerHeight,
    contentHeight,
    leadAnim,
    centerNext,
    prepended,
    pendingConversation,
    centerLockTop,
    centerLockUntil,
    stickToBottom,
    scrollAnim,
    cancelScrollAnim,
    applySpacer,
    cancelLeadAnim,
    applyLead,
    scrollTo,
    animateScrollTo,
    clearCenterLock,
    scrollToBottom,
    refreshScrollBtn,
    animateLeadTo,
    reconcileGrowth,
    prepareSend,
    conversationAssigned,
    reset,
    followBottom,
    preparePrepend,
    restorePrepend,
    cancelPrepend,
    revealEditing,
    noteUserScroll,
    onScroll,
  };
}

export function useConversationScroll({
  messages,
  conversationId,
}: {
  messages: Message[];
  conversationId: string | null;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const leadSpacerRef = useRef<HTMLDivElement | null>(null);
  const latestUserRef = useRef<HTMLDivElement | null>(null);
  const editingUserRef = useRef<HTMLDivElement | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const controllerRef = useRef<ReturnType<typeof createScrollController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createScrollController(
      {
        list: listRef,
        spacer: spacerRef,
        lead: leadSpacerRef,
        latestUser: latestUserRef,
        editingUser: editingUserRef,
        listEnd: listEndRef,
      },
      setShowScrollBtn,
    );
  }
  const scroll = controllerRef.current;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const key = conversationId ?? '';
    const reset = scroll.scrollConversation.current !== key;
    scroll.scrollConversation.current = key;

    if (reset) {
      scroll.cancelLeadAnim();
      scroll.applyLead(0);
      scroll.applySpacer(0);
      scroll.contentHeight.current = el.scrollHeight;
      scroll.stickToBottom.current = true;
      setShowScrollBtn(false);
      scroll.centerNext.current = false;
      scroll.pendingConversation.current = false;
      scroll.scrollTo(el, el.scrollHeight);
      return;
    }

    if (scroll.prepended.current) {
      scroll.prepended.current = false;
      scroll.contentHeight.current = el.scrollHeight - scroll.spacerHeight.current;
      return;
    }

    if (scroll.leadAnim.current != null) {
      scroll.contentHeight.current = el.scrollHeight - scroll.spacerHeight.current;
      return;
    }

    if (scroll.centerNext.current) {
      scroll.centerNext.current = false;
      scroll.applySpacer(0);
      const userEl = latestUserRef.current;
      if (!userEl) {
        scroll.contentHeight.current = el.scrollHeight;
        return;
      }
      const listRect = el.getBoundingClientRect();
      const userRect = userEl.getBoundingClientRect();
      const userTop = userRect.top - listRect.top + el.scrollTop;
      scroll.stickToBottom.current = false;
      const userCount = messages.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0);
      if (userCount === 1) {
        const lead = Math.max(0, el.clientHeight - userRect.height - userTop);
        scroll.cancelLeadAnim();
        scroll.applyLead(lead);
        scroll.contentHeight.current = el.scrollHeight - scroll.spacerHeight.current;
        scroll.scrollTo(el, 0);
        scroll.clearCenterLock();
        scroll.animateLeadTo(el, 0);
        return;
      }
      scroll.cancelLeadAnim();
      scroll.applyLead(0);
      const target = Math.max(0, userTop + userRect.height / 2 - el.clientHeight / 2);
      scroll.applySpacer(target + el.clientHeight - el.scrollHeight);
      scroll.contentHeight.current = el.scrollHeight - scroll.spacerHeight.current;
      scroll.animateScrollTo(el, target);
      scroll.centerLockTop.current = target;
      scroll.centerLockUntil.current = performance.now() + 30_000;
      scroll.refreshScrollBtn(el);
      return;
    }

    scroll.reconcileGrowth(el);
  }, [messages, conversationId, scroll]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (scroll.leadAnim.current != null) {
        scroll.contentHeight.current = el.scrollHeight - scroll.spacerHeight.current;
        return;
      }
      if (scroll.spacerHeight.current > el.clientHeight) scroll.applySpacer(el.clientHeight);
      scroll.reconcileGrowth(el);
    });
    const seen = new WeakSet<Element>();
    const sync = () => {
      for (const child of Array.from(el.children)) {
        if (seen.has(child)) continue;
        seen.add(child);
        ro.observe(child);
      }
    };
    sync();
    ro.observe(el);
    const mo = new MutationObserver(sync);
    mo.observe(el, { childList: true });
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [scroll]);

  return {
    listRef,
    spacerRef,
    leadSpacerRef,
    latestUserRef,
    editingUserRef,
    listEndRef,
    showScrollBtn,
    prepareSend: scroll.prepareSend,
    conversationAssigned: scroll.conversationAssigned,
    clearCenterLock: scroll.clearCenterLock,
    scrollToBottom: scroll.scrollToBottom,
    resetScroll: scroll.reset,
    followBottom: scroll.followBottom,
    preparePrepend: scroll.preparePrepend,
    restorePrepend: scroll.restorePrepend,
    cancelPrepend: scroll.cancelPrepend,
    revealEditing: scroll.revealEditing,
    noteUserScroll: scroll.noteUserScroll,
    onScroll: scroll.onScroll,
  };
}
