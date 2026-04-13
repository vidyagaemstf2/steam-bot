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
    } else {
      console.error('[error-handler] Unhandled Rejection:', String(reason));
    }
  });

  process.on('uncaughtException', (error) => {
    console.error('[error-handler] Uncaught Exception:', error.message, error.stack);
    void (async () => {
      await runShutdown(onShutdown);
      process.exit(1);
    })();
  });

  process.on('SIGINT', () => {
    console.log('[error-handler] Received SIGINT. Shutting down...');
    void (async () => {
      await runShutdown(onShutdown);
      process.exit(0);
    })();
  });

  process.on('SIGTERM', () => {
    console.log('[error-handler] Received SIGTERM. Shutting down...');
    void (async () => {
      await runShutdown(onShutdown);
      process.exit(0);
    })();
  });
}
