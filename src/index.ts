import { setupErrorHandlers } from '@/utils/error-handler.ts';
import { prisma, shutdownSteam, startBot } from '@/bot.ts';

setupErrorHandlers(() => {
  shutdownSteam();
  void prisma.$disconnect();
});

console.log('[index] Starting Steam bot...');

startBot();
