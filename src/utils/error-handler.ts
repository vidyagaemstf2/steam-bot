type ShutdownCallback = () => void;

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
    onShutdown?.();
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('[error-handler] Received SIGINT. Shutting down...');
    onShutdown?.();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('[error-handler] Received SIGTERM. Shutting down...');
    onShutdown?.();
    process.exit(0);
  });
}
