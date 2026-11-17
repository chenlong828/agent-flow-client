import { FileAttemptStore } from "../observer/attempt-store.ts";
import { FileSessionArchive } from "../observer/archive.ts";
import { ObserverHealth } from "../observer/health.ts";
import { ObservationRecorder } from "../observer/recorder.ts";
import { SessionRichHub } from "../observer/rich-hub.ts";
import { startObserverServer, type ObserverHandle } from "../observer/server.ts";
import type { AppConfig } from "./config.ts";
import type { Logger } from "../observability/logger.ts";
import type { RunRegistryPort } from "../observer/http-types.ts";

export type ObserverSetup = {
  attempts: FileAttemptStore;
  rich: SessionRichHub;
  recorder: ObservationRecorder;
  health: ObserverHealth;
  observer?: { handle: ObserverHandle; recorder: ObservationRecorder; attempts: FileAttemptStore; rich: SessionRichHub; cleanup: () => void };
};

/** `serve` 的观测面装配：创建存储/recorder，enabled 时启动 HTTP 与清理定时器。 */
export async function setupObserver(input: {
  config: AppConfig;
  stateRoot: string;
  runs: RunRegistryPort & { count?(): Promise<number> };
  logger: Logger;
}): Promise<ObserverSetup> {
  const health = new ObserverHealth();
  const attempts = new FileAttemptStore({ stateRoot: input.stateRoot, health });
  const rich = new SessionRichHub();
  const recorder = new ObservationRecorder({ stateRoot: input.stateRoot, attempts, rich, health });
  if (!input.config.observability.enabled) return { attempts, rich, recorder, health };

  let handle: ObserverHandle | undefined;
  let cleanup: (() => void) | undefined;
  try {
    handle = startObserverServer({
      config: input.config.observability,
      stateRoot: input.stateRoot,
      attempts,
      rich,
      runs: input.runs,
      files: new (await import("../workspace/files.ts")).WorkspaceFileReader(),
      archive: new FileSessionArchive({ stateRoot: input.stateRoot }),
      health,
      logger: (event, detail) =>
        input.logger.log({ level: "info", event, ...(detail === undefined ? {} : { msg: JSON.stringify(detail) }) }),
    });
    input.logger.log({ level: "info", event: "observability.started", msg: `bind=${input.config.observability.bind}:${handle.port}` });
    const runCleanup = async (): Promise<void> => {
      const running = (await attempts.list({ status: "running", limit: 200 })).items;
      const activeRuns = running.map((item) => item.runId).filter((runId): runId is string => runId !== undefined);
      const activeSessions = running.map((item) => item.sessionId).filter((sessionId): sessionId is string => sessionId !== undefined);
      await attempts.prune({ retentionDays: input.config.observability.retentionDays, maxBytes: input.config.observability.maxBytes }).catch(() => undefined);
      await input.runs.prune?.({ activeRunIds: activeRuns }).catch(() => undefined);
      await new FileSessionArchive({ stateRoot: input.stateRoot }).prune({ retentionDays: input.config.observability.retentionDays, maxBytes: input.config.observability.maxBytes, activeSessionIds: activeSessions }).catch(() => undefined);
    };
    void runCleanup();
    const timer = setInterval(() => void runCleanup(), 60 * 60 * 1000);
    timer.unref();
    cleanup = () => clearInterval(timer);
  } catch (error) {
    if (input.config.observability.required) throw error;
    input.logger.log({ level: "warn", event: "observability_disabled", msg: (error as Error).message });
  }
  return {
    attempts,
    rich,
    recorder,
    health,
    ...(handle === undefined || cleanup === undefined ? {} : { observer: { handle, recorder, attempts, rich, cleanup } }),
  };
}
