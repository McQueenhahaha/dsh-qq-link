// The opt-in `dsh-qq-bridge/schedule` adapter must extend the ScheduleService the
// host itself runs. Real layout (11-04, desktop rc.5): the plugin's real path is
// vendor/, outside the profile and the desktop app.asar, so a bare import from the
// plugin either fails (ERR_MODULE_NOT_FOUND, no schedule at all) or picks up an
// unrelated install next to it that carries its own Cordis copy.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const lib = fileURLToPath(new URL('../lib/', import.meta.url))

function fakeSdk(dir, inject) {
  const sdk = join(dir, 'node_modules', '@deepseek-ai', 'dsh-schedule')
  mkdirSync(join(sdk, 'lib'), { recursive: true })
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-schedule', type: 'module', exports: { '.': { default: './lib/index.js' } },
  }))
  writeFileSync(join(sdk, 'lib', 'index.js'), `export class ScheduleService {
    static inject = ${JSON.stringify(inject)}
    constructor(ctx) { this.ctx = ctx }
    create(sessionId, request, signal) { return { sessionId, request, signal } }
    async catalog() { return [{ id: 'task', scheduledAt: '2026-11-08T00:00:00.000Z', sessionId: 'session-test' }] }
    delete(request, signal) { return { request, signal } }
  }\n`)
  return pathToFileURL(join(sdk, 'lib', 'index.js')).href
}

function loadThroughHost(t, { decoy, probe = '' }) {
  const root = mkdtempSync(join(tmpdir(), 'qq-schedule-host-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = fakeSdk(join(root, 'host'), ['storageDomain'])
  // The plugin lives outside the host tree, like vendor/dsh-qq-bridge in production.
  const plugin = join(root, 'plugin', 'dsh-qq-bridge', 'lib')
  mkdirSync(plugin, { recursive: true })
  for (const name of ['schedule.js', 'poller-owned-schedule.mjs', 'awake-policy.mjs']) cpSync(join(lib, name), join(plugin, name))
  writeFileSync(join(root, 'plugin', 'dsh-qq-bridge', 'package.json'), JSON.stringify({ name: 'dsh-qq-bridge', type: 'module' }))
  if (decoy) fakeSdk(join(root, 'plugin'), ['decoy'])
  const entry = join(root, 'host', 'entry.mjs')
  writeFileSync(entry, `
    import assert from 'node:assert/strict'
    import { writeFileSync } from 'node:fs'
    const sdk = await import(${JSON.stringify(host)})
    const { default: Owned } = await import(${JSON.stringify(pathToFileURL(join(plugin, 'schedule.js')).href)})
    process.env.DSH_HOME = ${JSON.stringify(root)}
    ${probe}
    console.log(JSON.stringify({ hostClass: sdk.ScheduleService.prototype.isPrototypeOf(Owned.prototype), inject: Owned.inject }))
  `)
  const run = spawnSync(process.execPath, [entry], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout.trim().split(/\r?\n/).pop())
}

test('SCHEDULE-HOST-SDK-01: the adapter loads when only the host runtime has the schedule SDK', (t) => {
  assert.deepEqual(loadThroughHost(t, { decoy: false }), { hostClass: true, inject: ['storageDomain', 'bluefishQQPoller', 'sessionController'] })
})

test('SCHEDULE-HOST-SDK-02: an unrelated SDK install next to the plugin is not used', (t) => {
  assert.deepEqual(loadThroughHost(t, { decoy: true }), { hostClass: true, inject: ['storageDomain', 'bluefishQQPoller', 'sessionController'] })
})

test('SCHEDULE-HOST-SDK-03: adapter wraps the host API and applies sleep policy', (t) => {
  loadThroughHost(t, { decoy: false, probe: `
    writeFileSync(process.env.DSH_HOME + '/w17-config.json', JSON.stringify({ enabled: true, timeZone: 'Australia/Sydney' }))
    const context = { sessionController: { resolveAgent: async () => ({}) }, extend(meta) { return { ...this, ...meta } } }
    const schedule = new Owned(context, {})
    assert.notEqual(schedule.ctx.sessionController, context.sessionController)
    const signal = new AbortController().signal
    Date.now = () => Date.parse('2026-11-07T15:00:00+11:00')
    const ordinary = { title: '普通提醒', prompt: '测试', after_seconds: 7200 }
    assert.deepEqual(schedule.create('session-test', ordinary, signal), { sessionId: 'session-test', request: ordinary, signal })
    const life = { title: '生活闹钟·接力', prompt: '测试', after_seconds: 7200 }
    assert.equal(schedule.create('session-test', life).request.after_seconds, 900)
    assert.equal(life.after_seconds, 7200)
    Date.now = () => Date.parse('2026-11-07T22:55:00+11:00')
    assert.deepEqual(schedule.create('session-test', life).request, { title: life.title, prompt: life.prompt, at: '2026-11-07T22:00:00.000Z' })
    const daily = { title: life.title, prompt: life.prompt, daily: '12:00' }
    assert.deepEqual(schedule.create('session-test', daily).request, { ...daily, daily: { time: '09:00:00', time_zone: 'Australia/Sydney' } })
    assert.equal((await schedule.catalog())[0].sessionId, 'session-test')
    assert.equal((await schedule.catalog())[0].dueAt, '2026-11-08T00:00:00.000Z')
    assert.deepEqual(schedule.delete({ id: 'task', sessionId: 'session-test' }, signal), { request: { id: 'task', sessionId: 'session-test' }, signal })
    writeFileSync(process.env.DSH_HOME + '/w17-config.json', JSON.stringify({ enabled: false }))
    assert.equal(schedule.create('session-test', daily).request, daily)
    assert.equal(schedule.create('session-test', life).request.after_seconds, 7200)
  ` })
})
