import { Colors, notify } from '@/utils/discord.ts';

type ShutdownCallback = () => void | Promise<void>;

async function runShutdown(onShutdown?: ShutdownCallback): Promise<void> {
  if (!onShutdown) {
    return;
  }
  await Promise.resolve(onShutdown());
}

export function setupErrorHandlers(onShutdown?: ShutdownCallback): void {
  process.on('unhandledRejection', (reason) => {
    if (reason instanceof Error) {
      console.error('[error-handler] Unhandled Rejection:', reason.message, reason.stack);
      void notify('admin', {
        title: 'Unhandled rejection',
        description: reason.message,
        color: Colors.Red,
        fields: reason.stack ? [{ name: 'Stack', value: reason.stack.slice(0, 1024) }] : undefined,
      });
    } else {
      console.error('[error-handler] Unhandled Rejection:', String(reason));
      void notify('admin', {
        title: 'Unhandled rejection',
        description: String(reason),
        color: Colors.Red,
      });
    }
  });

  process.on('uncaughtException', (error) => {
    console.error('[error-handler] Uncaught Exception:', error.message, error.stack);
    void (async () => {
      await notify('admin', {
        title: 'Uncaught exception — bot shutting down',
        description: error.message,
        color: Colors.Red,
        fields: error.stack ? [{ name: 'Stack', value: error.stack.slice(0, 1024) }] : undefined,
      });
      await runShutdown(onShutdown);
      process.exit(1);
    })();
  });

  process.on('SIGINT', () => {
    console.log('[error-handler] Received SIGINT. Shutting down...');
    void (async () => {
      await notify('admin', {
        title: 'Bot shutting down',
        description: 'Received SIGINT.',
        color: Colors.Yellow,
      });
      await runShutdown(onShutdown);
      process.exit(0);
    })();
  });

  process.on('SIGTERM', () => {
    console.log('[error-handler] Received SIGTERM. Shutting down...');
    void (async () => {
      await notify('admin', {
        title: 'Bot shutting down',
        description: 'Received SIGTERM.',
        color: Colors.Yellow,
      });
      await runShutdown(onShutdown);
      process.exit(0);
    })();
  });
}
