/**
 * Express Application Factory
 *
 * Separated from index.ts so tests can import the app without starting the server.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config';
import roomsRouter from './routes/rooms';

export function createApp() {
  const app = express();

  // Security headers
  app.use(
    helmet({
      // Allow YouTube IFrame to work from the frontend
      contentSecurityPolicy: false,
    }),
  );

  // CORS — explicit origin whitelist from environment
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || config.cors.origins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`CORS: Origin ${origin} not allowed`));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());

  // ── Health Check ─────────────────────────────────────────────────────────────
  app.get('/health', async (_req, res) => {
    let dbStatus = 'connected';
    try {
      const { prisma } = await import('./db/prisma');
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'disconnected';
    }

    const { roomStateManager } = await import('./state/RoomStateManager');

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      db: dbStatus,
      activeRooms: roomStateManager.getActiveRoomCount(),
    });
  });

  // ── API Routes ────────────────────────────────────────────────────────────────
  app.use('/api/rooms', roomsRouter);

  // ── 404 Handler ───────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
  });

  // ── Error Handler ─────────────────────────────────────────────────────────────
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Never leak stack traces to clients
    const isProduction = config.isProduction;
    console.error('[Express Error]', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: isProduction ? 'An internal error occurred' : err.message,
      },
    });
  });

  return app;
}
