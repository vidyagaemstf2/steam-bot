import { stopApiServer } from '@/api/server.ts';
import { setupErrorHandlers } from '@/utils/error-handler.ts';
import { prisma, shutdownSteam, startBot } from '@/bot.ts';

setupErrorHandlers(async () => {
  await stopApiServer();
  await shutdownSteam();
  await prisma.$disconnect();
});

console.log('[index] Starting Steam bot...');

startBot();
