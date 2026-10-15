'use client';

/**
 * Room state management hook
 *
 * Manages the full room state received from the server:
 * - Handles sync_state (full snapshot on join/reconnect)
 * - Handles playback_updated (incremental playback changes)
 * - Handles participant lifecycle events
 * - Handles role changes
 * - Handles request events
 *
 * stateVersion guard: Rejects playback_updated events with a stateVersion
 * lower than the current local version to avoid applying stale broadcasts.
 */

import { useEffect, useReducer, useCallback, useRef } from 'react';
import { Socket } from 'socket.io-client';
import {
  SyncStatePayload,
  PlaybackUpdatedPayload,
  ParticipantDTO,
  PlaybackRequestDTO,
  Role,
  PlaybackStatus,
} from '@watchparty/types';

export interface RoomPlaybackState {
  videoId: string;
  status: PlaybackStatus;
  anchorPositionSeconds: number;
  anchorTimestampMs: number;
  serverTimeMs: number;
  stateVersion: number;
}

export interface RoomState {
  roomId: string;
  roomCode: string;
  roomTitle: string;
  hostUserId: string;
  currentUser: { userId: string; displayName: string; role: Role } | null;
  participants: ParticipantDTO[];
  playback: RoomPlaybackState | null;
  pendingRequests: PlaybackRequestDTO[];
  isLoaded: boolean;
}

type RoomAction =
  | { type: 'SYNC_STATE'; payload: SyncStatePayload }
  | { type: 'PLAYBACK_UPDATED'; payload: PlaybackUpdatedPayload }
  | { type: 'USER_JOINED'; payload: ParticipantDTO }
  | { type: 'USER_LEFT'; payload: { userId: string } }
  | { type: 'ROLE_ASSIGNED'; payload: { userId: string; newRole: Role } }
  | { type: 'PARTICIPANT_REMOVED'; payload: { userId: string } }
  | { type: 'REQUEST_CREATED'; payload: PlaybackRequestDTO }
  | { type: 'REQUEST_RESOLVED'; payload: { requestId: string; status: 'APPROVED' | 'REJECTED' } }
  | { type: 'HOST_TRANSFERRED'; payload: { previousHostUserId: string; newHostUserId: string } };

const initialState: RoomState = {
  roomId: '',
  roomCode: '',
  roomTitle: '',
  hostUserId: '',
  currentUser: null,
  participants: [],
  playback: null,
  pendingRequests: [],
  isLoaded: false,
};

function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case 'SYNC_STATE':
      return {
        roomId: action.payload.room.id,
        roomCode: action.payload.room.code,
        roomTitle: action.payload.room.title,
        hostUserId: action.payload.room.hostUserId,
        currentUser: action.payload.currentUser,
        participants: action.payload.participants,
        playback: action.payload.playback,
        pendingRequests: action.payload.pendingRequests,
        isLoaded: true,
      };

    case 'PLAYBACK_UPDATED': {
      const { payload } = action;
      // stateVersion guard: reject stale updates
      if (state.playback && payload.stateVersion <= state.playback.stateVersion) {
        return state;
      }
      return {
        ...state,
        playback: {
          videoId: payload.videoId,
          status: payload.status,
          anchorPositionSeconds: payload.anchorPositionSeconds,
          anchorTimestampMs: payload.anchorTimestampMs,
          serverTimeMs: payload.serverTimeMs,
          stateVersion: payload.stateVersion,
        },
      };
    }

    case 'USER_JOINED':
      return {
        ...state,
        participants: [
          ...state.participants.filter((p) => p.userId !== action.payload.userId),
          action.payload,
        ],
      };

    case 'USER_LEFT':
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.userId === action.payload.userId ? { ...p, isOnline: false } : p,
        ),
      };

    case 'ROLE_ASSIGNED':
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.userId === action.payload.userId ? { ...p, role: action.payload.newRole } : p,
        ),
        currentUser:
          state.currentUser?.userId === action.payload.userId
            ? { ...state.currentUser, role: action.payload.newRole }
            : state.currentUser,
      };

    case 'PARTICIPANT_REMOVED':
      return {
        ...state,
        participants: state.participants.filter((p) => p.userId !== action.payload.userId),
      };

    case 'REQUEST_CREATED':
      return {
        ...state,
        pendingRequests: [...state.pendingRequests, action.payload],
      };

    case 'REQUEST_RESOLVED':
      return {
        ...state,
        pendingRequests: state.pendingRequests.filter(
          (r) => r.id !== action.payload.requestId,
        ),
      };

    case 'HOST_TRANSFERRED': {
      const { previousHostUserId, newHostUserId } = action.payload;
      return {
        ...state,
        hostUserId: newHostUserId,
        participants: state.participants.map((p) => {
          if (p.userId === previousHostUserId) return { ...p, role: 'PARTICIPANT' as Role };
          if (p.userId === newHostUserId) return { ...p, role: 'HOST' as Role };
          return p;
        }),
        currentUser:
          state.currentUser?.userId === previousHostUserId
            ? { ...state.currentUser, role: 'PARTICIPANT' as Role }
            : state.currentUser?.userId === newHostUserId
              ? { ...state.currentUser, role: 'HOST' as Role }
              : state.currentUser,
      };
    }

    default:
      return state;
  }
}

export function useRoomState(socket: Socket | null) {
  const [state, dispatch] = useReducer(roomReducer, initialState);

  useEffect(() => {
    if (!socket) return;

    socket.on('sync_state', (data) => dispatch({ type: 'SYNC_STATE', payload: data }));
    socket.on('playback_updated', (data) => dispatch({ type: 'PLAYBACK_UPDATED', payload: data }));
    socket.on('user_joined', (data) => dispatch({ type: 'USER_JOINED', payload: data }));
    socket.on('user_left', (data) => dispatch({ type: 'USER_LEFT', payload: data }));
    socket.on('role_assigned', (data) => dispatch({ type: 'ROLE_ASSIGNED', payload: data }));
    socket.on('participant_removed', (data) =>
      dispatch({ type: 'PARTICIPANT_REMOVED', payload: data }),
    );
    socket.on('playback_request_created', (data) =>
      dispatch({ type: 'REQUEST_CREATED', payload: data }),
    );
    socket.on('playback_request_resolved', (data) =>
      dispatch({ type: 'REQUEST_RESOLVED', payload: data }),
    );
    socket.on('host_transferred', (data) =>
      dispatch({ type: 'HOST_TRANSFERRED', payload: data }),
    );

    return () => {
      socket.off('sync_state');
      socket.off('playback_updated');
      socket.off('user_joined');
      socket.off('user_left');
      socket.off('role_assigned');
      socket.off('participant_removed');
      socket.off('playback_request_created');
      socket.off('playback_request_resolved');
      socket.off('host_transferred');
    };
  }, [socket]);

  /**
   * Compute the live authoritative position at the current moment.
   * Uses anchor math: position = anchorPositionSeconds + elapsed
   */
  const computeCurrentPosition = useCallback((): number => {
    if (!state.playback) return 0;
    if (state.playback.status === 'PAUSED') {
      return state.playback.anchorPositionSeconds;
    }
    const elapsed = (Date.now() - state.playback.anchorTimestampMs) / 1000;
    return Math.max(0, state.playback.anchorPositionSeconds + elapsed);
  }, [state.playback]);

  return { state, dispatch, computeCurrentPosition };
}
