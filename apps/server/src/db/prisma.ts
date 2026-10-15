/**
 * Prisma client singleton with Neon serverless adapter.
 *
 * Uses @neondatabase/serverless to communicate with Neon over HTTPS (port 443)
 * instead of raw TCP (port 5432). This is required in environments where
 * outbound port 5432 is blocked (e.g. restricted corporate/ISP networks).
 *
 * The adapter passes all Prisma queries through the Neon HTTP proxy, which
 * is functionally identical to a direct connection for all query types.
 */

import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient } from '@prisma/client';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// Use the ws package for WebSocket transport in Node.js
// (Neon serverless driver uses WebSockets for transaction support)
neonConfig.webSocketConstructor = ws;

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('Missing required environment variable: DATABASE_URL');
}

// Strip any Prisma-only params that confuse the PG connection string parser
const cleanUrl = DATABASE_URL.split('?')[0] + '?sslmode=require';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const pool = new Pool({ connectionString: cleanUrl });
  const adapter = new PrismaNeon(pool);

  return new PrismaClient({
    adapter,
    log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}
