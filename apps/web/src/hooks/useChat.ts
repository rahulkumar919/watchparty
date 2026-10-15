'use client';

/**
 * useChat — real-time chat hook
 *
 * Responsibilities:
 * - Seeds message list from SyncStatePayload.recentMessages on join
 * - Listens to 'message_received' to append live messages
 * - Emits 'send_message' with the user's body text
 * - Deduplicates by message id so reconnect replays don't double-render
 * - Tracks sending state and per-send error
 * - Auto-scrolls to the latest message unless the user has scrolled up
 *
 * Canonical delivery strategy (no optimistic insert):
 * The server broadcasts the persisted DTO back to the sender too.
 * The send callback only clears the input on success; the message
 * appears when 'message_received' fires like every other participant's.
 * This avoids the "appears twice" problem without needing client IDs.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import type { ChatMessageDTO, SocketResponse } from '@watchparty/types';

export interface UseChatOptions {
  /** Initial history loaded from SyncStatePayload.recentMessages on join. */
  initialMessages?: ChatMessageDTO[];
}

export function useChat(socket: Socket | null, options: UseChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessageDTO[]>(options.initialMessages ?? []);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Track ids we've already appended so reconnect replays don't duplicate
  const seenIds = useRef<Set<string>>(new Set(options.initialMessages?.map((m) => m.id) ?? []));

  // Ref to the scrollable message container — consumers attach this to their div
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Whether the user has manually scrolled up (suppress auto-scroll while true)
  const isAtBottomRef = useRef(true);

  // ── Seed history when initialMessages changes (i.e. after join) ─────────────
  useEffect(() => {
    if (!options.initialMessages?.length) return;
    setMessages(options.initialMessages);
    seenIds.current = new Set(options.initialMessages.map((m) => m.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.initialMessages]);

  // ── Listen for live messages ─────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    const handleMessage = (msg: ChatMessageDTO) => {
      if (seenIds.current.has(msg.id)) return; // deduplicate
      seenIds.current.add(msg.id);
      setMessages((prev) => [...prev, msg]);
    };

    socket.on('message_received', handleMessage);
    return () => { socket.off('message_received', handleMessage); };
  }, [socket]);

  // ── Auto-scroll to bottom when new messages arrive ───────────────────────────
  // Only scrolls if the user is already near the bottom (isAtBottomRef).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ── Track whether user is at the bottom ──────────────────────────────────────
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Consider "at bottom" if within 60px of the end
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  // ── Send a message ───────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    (body: string, onSuccess?: () => void) => {
      const trimmed = body.trim();
      if (!trimmed || !socket) return;

      setSending(true);
      setSendError(null);
      // Snap to bottom on own send
      isAtBottomRef.current = true;

      socket.emit('send_message', { body: trimmed }, (res: SocketResponse<ChatMessageDTO>) => {
        setSending(false);
        if (res.success) {
          onSuccess?.();
        } else {
          setSendError(res.error?.message ?? 'Failed to send message');
        }
      });
    },
    [socket],
  );

  return { messages, sendMessage, sending, sendError, setSendError, scrollRef, onScroll };
}
