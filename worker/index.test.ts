import { describe, expect, test } from 'bun:test'
import worker from './index'
const env = { ASSETS: { fetch: async () => new Response('<!doctype html><title>fixture</title>', { headers: { 'content-type': 'text/html' } }) } }
describe('public fixture worker', () => {
  test('health declares static no-storage mode', async () => {
    const r = await worker.fetch(new Request('https://example.test/health'), env)
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ok:true,service:'session-search',mode:'static-fixture',storage:'none'})
  })
  test('search and status surfaces are deterministic', async () => {
    const s = await worker.fetch(new Request('https://example.test/api/status'), env); const sd:any = await s.json()
    expect(sd.sessions).toBe(120); expect(sd.horizons.short).toBe(24)
    const q = await worker.fetch(new Request('https://example.test/api/search?q=embedding'), env); const qd:any = await q.json()
    expect(qd.route).toBe('trigram'); expect(qd.hits.length).toBeGreaterThan(0)
  })
})
