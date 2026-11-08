// The follower must not even open the schedule domain: its cached task snapshot
// would otherwise replay reminders after ownership changes.
export function pollerOwnedSchedule(ScheduleService) {
  return class BluefishOwnedSchedule extends ScheduleService {
    static inject = [...ScheduleService.inject, 'bluefishQQPoller', 'sessionController']
  }
}

export function publishPollerOwner(ctx, instance) {
  const fiber = ctx.plugin({
    name: 'bluefish-qq-poller-owner',
    apply: (ownerCtx) => { ownerCtx.provide('bluefishQQPoller', { instance }) },
  })
  return async () => {
    await fiber.dispose()
    // Disposal may already have started with the parent fiber. Await the fiber
    // as well: Cordis effect disposers return void on a second invocation.
    await fiber.await()
  }
}
