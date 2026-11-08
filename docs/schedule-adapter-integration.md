# Schedule adapter integration

The `dsh-qq-link/schedule` adapter must be loaded against the host's own
`@deepseek-ai/dsh-schedule` package. Its `ScheduleService` subclass declares
both `bluefishQQPoller` and `sessionController` as injected services.

The `sessionController` dependency is required because the adapter wraps it to
apply the sleep policy. If the dependency is omitted, Cordis can import the
module but will not construct the service; callers then observe
`ctx.get('schedule') === undefined` and the durable schedule store stops
advancing.

For a profile that replaces the bundled schedule entry, keep the native entry
disabled and insert the adapter after the bridge bundle:

```yaml
- id: schedule
  disabled: true
- insert:
    - id: bluefish-schedule
      name: dsh-qq-link/schedule
```

The host integration must also publish the `bluefishQQPoller` service from the
single instance that owns the QQ poller lease. The adapter intentionally waits
for that owner before activating its schedule domain.
