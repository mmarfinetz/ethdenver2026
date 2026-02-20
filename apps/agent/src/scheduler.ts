export type SchedulerConfig = {
  getIntervalSeconds: () => number;
};

export function startScheduler(config: SchedulerConfig, task: () => Promise<void>): void {
  let isRunning = false;
  let timer: NodeJS.Timeout | undefined;

  const scheduleNext = () => {
    const seconds = Math.max(1, Math.floor(config.getIntervalSeconds()));
    timer = setTimeout(() => {
      void run();
    }, seconds * 1000);
  };

  const run = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      await task();
    } catch (error) {
      console.error("[scheduler] run failed", error);
    } finally {
      isRunning = false;
      scheduleNext();
    }
  };

  void run();
}
