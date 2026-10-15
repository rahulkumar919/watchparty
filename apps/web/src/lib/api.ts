/**
 * REST API Client
 * Wraps fetch calls to the backend REST API with typed responses.
 */

import {
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRoomRequest,
  JoinRoomResponse,
} from '@watchparty/types';

const BASE_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });

  const data = await res.json();

  if (!res.ok) {
    const errorData = data as { error: { code: string; message: string } };
    throw new ApiError(
      errorData.error?.code ?? 'UNKNOWN',
      errorData.error?.message ?? 'Request failed',
      res.status,
    );
  }

  return data as T;
}

export const api = {
  /**
   * Create a new watch party room.
   */
  createRoom: (body: CreateRoomRequest): Promise<CreateRoomResponse> =>
    fetchJson<CreateRoomResponse>(`${BASE_URL}/api/rooms`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Join an existing room by code.
   */
  joinRoom: (body: JoinRoomRequest): Promise<JoinRoomResponse> =>
    fetchJson<JoinRoomResponse>(`${BASE_URL}/api/rooms/join`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Get room info by code (unauthenticated).
   */
  getRoom: (
    code: string,
  ): Promise<{ id: string; code: string; title: string; isClosed: boolean; onlineCount: number }> =>
    fetchJson(`${BASE_URL}/api/rooms/${code}`),
};

export { ApiError };
