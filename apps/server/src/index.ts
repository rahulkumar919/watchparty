/**
 * Server Entry Point
 *
 * Creates the HTTP server, attaches Socket.IO, and starts listening.
 */

import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
} from '@watchparty/types';
import { createApp } from './app';
import { config } from './config';
import { socketAuthMiddleware } from './socket/middleware';
import { registerSocketHandlers } from './socket/handlers';
import { prisma } from './db/prisma';

async function main() {
  // Verify database connection on startup
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('[DB] Connected to PostgreSQL ✓');
  } catch (err) {
    console.error('[DB] Failed to connect to PostgreSQL:', err);
    process.exit(1);
  }

  const app = createApp();
  const httpServer = http.createServer(app);

  // ── Socket.IO Setup ──────────────────────────────────────────────────────────
  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    httpServer,
    {
      cors: {
        origin: config.cors.origins,
        credentials: true,
      },
      // Allow polling fallback for environments where WebSockets are blocked
      transports: ['websocket', 'polling'],
      // Ping timeout and interval for connection health checks
      pingTimeout: 30000,
      pingInterval: 25000,
    },
  );

  // Apply auth middleware to all socket connections
  io.use(socketAuthMiddleware);

  // Register event handlers for each connected socket
  io.on('connection', (socket) => {
    const { userId, displayName, roomCode } = socket.data.session;
    console.log(`[Socket] Connected: ${displayName} (${userId}) → room ${roomCode} [${socket.id}]`);
    registerSocketHandlers(io, socket);
  });

  // ── Start Listening ──────────────────────────────────────────────────────────
  httpServer.listen(config.port, () => {
    console.log(`[Server] Running on port ${config.port} (${config.nodeEnv})`);
    console.log(`[Server] CORS origins: ${config.cors.origins.join(', ')}`);
  });

  // ── Graceful Shutdown ────────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`[Server] Received ${signal}, shutting down gracefully...`);
    await prisma.$disconnect();
    httpServer.close(() => {
      console.log('[Server] HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
