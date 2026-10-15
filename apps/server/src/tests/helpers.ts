/**
 * Integration test helpers
 *
 * Provides a pre-configured test app instance that connects to a real database
 * (uses the DATABASE_URL from .env.test or .env).
 *
 * Design: Each integration test suite gets a clean DB state by wrapping every
 * test in a transaction that is rolled back after. This is faster than
 * truncating tables and avoids test pollution.
 */

import 'dotenv/config';
import { createApp } from '../app';
import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
} from '@watchparty/types';
import { socketAuthMiddleware } from '../socket/middleware';
import { registerSocketHandlers } from '../socket/handlers';
import { config } from '../config';
import { prisma } from '../db/prisma';

export interface TestServer {
  httpServer: HttpServer;
  io: SocketServer;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Starts a test HTTP + Socket.IO server on a random available port.
 * Call close() in afterAll to shut down cleanly.
 */
export async function startTestServer(): Promise<TestServer> {
  const app = createApp();
  const httpServer = new HttpServer(app);

  const io = new SocketServer<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: { origin: '*' },
    transports: ['websocket'],
  });

  io.use(socketAuthMiddleware);
  io.on('connection', (socket) => {
    registerSocketHandlers(io, socket);
  });

  // Port 0 = OS assigns a free port
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    httpServer,
    io,
    port,
    url: `http://localhost:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        io.close();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Cleans up test rooms created during tests by room code.
 * Cascades to participants, sessions, and requests.
 */
export async function cleanupRoom(roomCode: string) {
  await prisma.room.deleteMany({ where: { code: roomCode } });
}

/**
 * Waits for a socket to emit a specific event.
 */
export function waitForEvent<T>(
  socket: { on: (event: string, listener: (data: T) => void) => void },
  event: string,
  timeout = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for event: ${event}`)), timeout);
    socket.on(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
