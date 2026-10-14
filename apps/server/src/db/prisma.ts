import { PrismaClient } from '@prisma/client';

/**
 * Singleton Prisma client instance.
 * Re-using a single instance across the process avoids connection pool exhaustion.
 * In tests, each test file gets its own instance via the test setup.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}
