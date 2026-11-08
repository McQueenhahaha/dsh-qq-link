import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pollerOwnedSchedule } from './poller-owned-schedule.mjs'
import { lifeReminderRequest, scheduleSleepContext } from './awake-policy.mjs'

// Opt-in replacement for the profile's `schedule` entry; original SDK unchanged.
// Extend the SDK the host itself runs, resolved from the host entry script: this
// plugin's real path (vendor/) is outside the profile and the desktop app.asar, so
// a bare import either fails or picks up an unrelated install with its own Cordis.
const sdk = createRequire(process.argv[1]).resolve('@deepseek-ai/dsh-schedule')
const { ScheduleService } = await import(pathToFileURL(sdk).href)

function settings() {
  if (!process.env.DSH_HOME) return null
  try { return JSON.parse(readFileSync(join(process.env.DSH_HOME, 'w17-config.json'), 'utf8')) } catch { return null }
}

function requestForSettings(request, cfg) {
  if (!cfg?.enabled || !/^生活闹钟·/.test(String(request?.title || ''))) return request
  if (request.daily !== undefined) {
    const daily = typeof request.daily === 'string'
      ? { time: request.daily, time_zone: cfg.timeZone || 'Australia/Sydney' }
      : request.daily
    return { ...request, daily: { ...daily, time: '09:00:00', time_zone: daily.time_zone || cfg.timeZone || 'Australia/Sydney' } }
  }
  return lifeReminderRequest(request, Date.now(), cfg.timeZone)
}
export default class BluefishSleepSchedule extends pollerOwnedSchedule(ScheduleService) {
  constructor(ctx, config) { super(scheduleSleepContext(ctx, settings), config) }
  create(sessionId, request, signal) {
    return super.create(sessionId, requestForSettings(request, settings()), signal)
  }
  async catalog() {
    return (await super.catalog()).map((task) => ({ ...task, dueAt: task.scheduledAt }))
  }
}
