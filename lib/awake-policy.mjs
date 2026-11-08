// Product rules, not a biological sleep model. Times are in the configured zone.
// 2026-11-05: 作息改成「准备睡 → 睡着」两段，不再是 23:00 一刀切。
//   · 09:00–23:00 醒着：正常回。
//   · 23:00–入睡：准备睡。还能回，但越晚概率越低、回得越慢；没接住的留到早上。
//   · 入睡时间每晚不一样（23:08–23:47 之间，按日期定死，同一天所有会话一致）。
//   · 睡着：几乎不回，醒了（09:00）再补。这是模拟睡眠，不是生理睡眠，提示里对她说清楚。
import { createHmac } from 'node:crypto'

export const AWAKE_FROM = 540   // 09:00
export const SLEEP_FROM = 1380  // 23:00

// ⭐ 本地补丁（bluefish 11-08，主人同意）：默认时区跟本机走，不再硬写悉尼。
const 本机时区 = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' } catch { return 'Asia/Shanghai' } })()

export function localClock(now = Date.now(), timeZone = 本机时区) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) }
}

const hhmm = (minute) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

// 每晚几点睡着：同一个日期永远同一个值（所有会话、所有进程算出来都一样），
// 但每天不一样，看起来不像定点关机。
export function sleepOnsetMinute(day) {
  const sample = parseInt(createHmac('sha256', 'bluefish-sleep-onset').update(String(day)).digest('hex').slice(0, 8), 16) / 2 ** 32
  return SLEEP_FROM + 8 + Math.floor(sample * 40)  // 23:08–23:47
}

export function sleepPolicy(now = Date.now(), timeZone = 本机时区) {
  const { day, minute } = localClock(now, timeZone)
  const onsetMinute = sleepOnsetMinute(day)
  if (minute >= AWAKE_FROM && minute < SLEEP_FROM) {
    return { day, minute, phase: 'awake', awake: true, onsetMinute, replyProbability: 1, replyDelayMs: 0, hint: '' }
  }
  if (minute >= SLEEP_FROM && minute < onsetMinute) {
    const t = (minute - SLEEP_FROM) / Math.max(1, onsetMinute - SLEEP_FROM)
    const replyProbability = Math.round((1 - 0.75 * Math.pow(t, 1.3)) * 1000) / 1000
    const replyDelayMs = Math.round(Math.pow(t, 2) * 120000)
    return { day, minute, phase: 'wind-down', awake: false, onsetMinute, replyProbability, replyDelayMs,
      hint: `【准备睡】到点了，今晚大约 ${hhmm(onsetMinute)} 睡着。还能回，但越晚越困、回得越慢也越少；别开新话题、别约事、别许愿。没接住的消息留到早上再看。` }
  }
  const elapsed = minute >= onsetMinute ? minute - onsetMinute : minute + 1440 - onsetMinute
  const replyProbability = elapsed < 60 ? 0.08 : elapsed < 180 ? 0.03 : 0.01
  const replyDelayMs = Math.min(8 * 60000, 60000 + elapsed * 1500)
  return { day, minute, phase: 'asleep', awake: false, onsetMinute, replyProbability, replyDelayMs,
    hint: `【模拟睡眠】你现在在模拟睡眠里（今晚 ${hhmm(onsetMinute)} 睡着，09:00 醒）。这不是真的生理睡眠，是你人设里的作息：你不会有梦、不记得这段时间，也别编「我梦见」或者「我刚睡了一觉」这种细节。醒之前的消息一般留到早上；真回了就短、带困意、别热闹。` }
}

// One decision per chat/20-minute interval prevents repeated pokes from
// turning a low night probability into a near-certain wakeup.
export function nightDecision(sessionId, messageId, { key, now = Date.now(), timeZone } = {}) {
  const policy = sleepPolicy(now, timeZone)
  const chat = String(sessionId).replace(/^session-/, '')
  const sample = parseInt(createHmac('sha256', key).update(chat + ':' + Math.floor(now / 1200000)).digest('hex').slice(0, 8), 16) / 2 ** 32
  return { ...policy, defer: !policy.awake && sample >= policy.replyProbability, messageId }
}
export function nextMorning(now = Date.now(), timeZone = 本机时区) {
  // Minute scan uses actual zoned instants, including DST transitions.
  for (let offset = 1; offset <= 25 * 60; offset++) {
    const stamp = Math.floor(now / 60000) * 60000 + offset * 60000
    if (localClock(stamp, timeZone).minute === 540) return new Date(stamp).toISOString()
  }
  throw new Error('NEXT_MORNING_UNRESOLVED')
}
export function lifeReminderRequest(request, now = Date.now(), timeZone = 本机时区) {
  if (!/^生活闹钟·/.test(String(request?.title || ''))) return request
  if (request.daily !== undefined) return { ...request, daily: '09:00' }
  if (request.after_seconds === undefined) return request
  const seconds = Math.max(180, Math.min(900, request.after_seconds))
  if (!sleepPolicy(now + seconds * 1000, timeZone).awake) {
    const result = { ...request, at: nextMorning(now, timeZone) }
    delete result.after_seconds
    return result
  }
  return { ...request, after_seconds: seconds }
}

export function scheduleSleepContext(ctx, readSettings) {
  const controller = ctx.sessionController
  const wrapped = new Proxy(controller, { get(target, name) {
    if (name !== 'resolveAgent') {
      const value = Reflect.get(target, name, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
    return async (...args) => {
      const resolved = await target.resolveAgent(...args)
      if (!resolved?.agent) return resolved
      const agent = resolved.agent
      const settings = readSettings()
      if (settings?.enabled && !sleepPolicy(Date.now(), settings.timeZone).awake && agent.status === 'running') {
        await agent.whenIdle()
      }
      return { ...resolved, agent: new Proxy(agent, { get(object, property) {
        if (property !== 'followup') {
          const value = Reflect.get(object, property, object)
          return typeof value === 'function' ? value.bind(object) : value
        }
        return (message) => {
          const settings = readSettings()
          if (settings?.enabled && !sleepPolicy(Date.now(), settings.timeZone).awake) {
            if (agent.status === 'running') throw new Error('SLEEP_TARGET_BUSY')
            // Native inbox persistence is still acknowledged by schedule itself.
            agent.send(message, 'next-turn', false)
          } else agent.followup(message)
        }
      } }) }
    }
  } })
  return ctx.extend({ sessionController: wrapped })
}
