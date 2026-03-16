import { log } from "./logger.js";

type CleanupHandler = () => Promise<void> | void;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

export class ShutdownManager {
  private cleanupHandlers = new Map<string, CleanupHandler>();
  private isShuttingDown = false;
  private signalHandlersInstalled = false;
  private unhandledRejectionHandlerInstalled = false;
  private uncaughtExceptionHandlerInstalled = false;

  /**
   * Register a cleanup handler that will be executed during shutdown.
   * If a handler with the same name already exists, it will be replaced.
   */
  registerCleanup(name: string, handler: CleanupHandler): void {
    this.cleanupHandlers.set(name, handler);
  }

  /**
   * Unregister a cleanup handler by name.
   */
  unregisterCleanup(name: string): void {
    this.cleanupHandlers.delete(name);
  }

  /**
   * Execute all cleanup handlers and exit gracefully.
   * This method is idempotent — subsequent calls are no-ops.
   * Returns true if all handlers succeeded, false if any failed.
   */
  async shutdown(timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<boolean> {
    if (this.isShuttingDown) {
      log.debug("Shutdown already in progress, skipping duplicate call");
      return true;
    }

    this.isShuttingDown = true;
    log.info("Shutting down gracefully...");

    const errors: Array<{ name: string; error: Error }> = [];

    for (const [name, handler] of this.cleanupHandlers) {
      try {
        log.debug(`Running cleanup handler: ${name}`);
        await Promise.race([
          handler(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Cleanup timeout (${timeoutMs}ms)`)), timeoutMs)
          ),
        ]);
        log.debug(`Cleanup handler completed: ${name}`);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error(`Cleanup handler "${name}" failed: ${error.message}`);
        errors.push({ name, error });
      }
    }

    if (errors.length > 0) {
      log.error(`Shutdown completed with ${errors.length} error(s)`);
      return false;
    } else {
      log.info("Shutdown complete");
      return true;
    }
  }

  /**
   * Install SIGINT and SIGTERM signal handlers that trigger graceful shutdown.
   */
  installSignalHandlers(): void {
    if (this.signalHandlersInstalled) {
      log.debug("Signal handlers already installed, skipping");
      return;
    }

    const handleSignal = (signal: string) => {
      log.info(`\nReceived ${signal}, shutting down...`);
      this.shutdown()
        .then((success) => {
          process.exit(success ? 0 : 1);
        })
        .catch((err) => {
          log.error(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        });
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));

    this.signalHandlersInstalled = true;
    log.debug("Signal handlers installed (SIGINT, SIGTERM)");
  }

  /**
   * Install an unhandledRejection handler that triggers graceful shutdown.
   */
  installUnhandledRejectionHandler(): void {
    if (this.unhandledRejectionHandlerInstalled) {
      log.debug("unhandledRejection handler already installed, skipping");
      return;
    }

    process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
      const errorMsg = reason instanceof Error ? reason.message : String(reason);
      log.error(`Unhandled promise rejection: ${errorMsg}`);
      log.debug(`Promise: ${promise}`);

      this.shutdown()
        .then(() => {
          process.exit(1);
        })
        .catch((err) => {
          log.error(`Shutdown failed after unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        });
    });

    this.unhandledRejectionHandlerInstalled = true;
    log.debug("unhandledRejection handler installed");
  }

  /**
   * Install an uncaughtException handler that triggers graceful shutdown.
   */
  installUncaughtExceptionHandler(): void {
    if (this.uncaughtExceptionHandlerInstalled) {
      log.debug("uncaughtException handler already installed, skipping");
      return;
    }

    process.on("uncaughtException", (error: Error, origin: string) => {
      log.error(`Uncaught exception (${origin}): ${error.message}`);
      log.debug(`Stack: ${error.stack}`);

      this.shutdown()
        .then(() => {
          process.exit(1);
        })
        .catch((err) => {
          log.error(`Shutdown failed after uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        });
    });

    this.uncaughtExceptionHandlerInstalled = true;
    log.debug("uncaughtException handler installed");
  }

  /**
   * Clear all registered cleanup handlers (used for testing).
   */
  clearHandlers(): void {
    this.cleanupHandlers.clear();
    this.isShuttingDown = false;
  }
}

/**
 * Global singleton shutdown manager.
 */
export const shutdownManager = new ShutdownManager();
