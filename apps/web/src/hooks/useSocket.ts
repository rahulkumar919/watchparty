'use client';

/**
 * Socket.IO connection hook
 *
 * Manages the Socket.IO client lifecycle:
 * - Connects with the session token on mount
 * - Reconnects automatically (Socket.IO built-in)
 * - Disconnects on unmount or when token changes
 * - Exposes a *reactive* socket instance and connection status
 *
 * Reactivity note: Socket.IO socket objects are mutable — storing them in a
 * ref means changes don't trigger re-renders. We expose both a ref (for use
 * inside callbacks / effects where we never want stale closures) AND a
 * reactive state copy that updates on connect/disconnect so components that
 * depend on the socket object re-render correctly.
 */

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@watchparty/types';

const SOCKET_URL = process.env['NEXT_PUBLIC_SOCKET_URL'] ?? 'http://localhost:4000';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export function useSocket(token: string | null) {
  const socketRef = useRef<AppSocket | null>(null);
  // Reactive copy — updated whenever the socket connects or disconnects so
  // downstream hooks/components that read `socket` re-render.
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  useEffect(() => {
    if (!token) {
      setSocket(null);
      setStatus('disconnected');
      return;
    }

    // Prevent double-connection in React Strict Mode
    if (socketRef.current?.connected) return;

    const s = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 10000,
    });

    socketRef.current = s;
    setStatus('connecting');

    s.on('connect', () => {
      setStatus('connected');
      // Publish the socket instance reactively so consumers re-render
      setSocket(s);
    });

    s.on('disconnect', () => {
      setStatus('disconnected');
      setSocket(null);
    });

    s.on('connect_error', () => {
      setStatus('error');
    });

    return () => {
      s.disconnect();
      socketRef.current = null;
      setSocket(null);
      setStatus('disconnected');
    };
  }, [token]);

  return { socket, socketRef, status };
}
