import { describe, expect, it } from 'vitest'
import { sanitizeModelInvocationDetailsForLog } from '@/lib/workers/utils'

describe('sanitizeModelInvocationDetailsForLog', () => {
  it('replaces data URLs with length + header summary', () => {
    const b64 = 'a'.repeat(5000)
    const dataUrl = `data:image/png;base64,${b64}`
    const out = sanitizeModelInvocationDetailsForLog({
      referenceImages: [dataUrl],
      prompt: 'short',
    }) as Record<string, unknown>
    const refs = out.referenceImages as unknown[]
    expect(Array.isArray(refs)).toBe(true)
    const first = refs[0] as Record<string, unknown>
    expect(first.isDataUrl).toBe(true)
    expect(first.length).toBe(dataUrl.length)
    expect(typeof first.preview).toBe('string')
    expect(String(first.preview)).toContain('<5000 base64 chars>')
    expect(String(first.preview)).not.toContain('aaaa')
  })

  it('replaces long raw base64 strings', () => {
    const raw = `A${'B'.repeat(300)}/+9=${'C'.repeat(200)}`
    const out = sanitizeModelInvocationDetailsForLog({ blob: raw }) as Record<string, unknown>
    const blob = out.blob as Record<string, unknown>
    expect(blob.kind).toBe('base64')
    expect(blob.length).toBe(raw.length)
    expect(String(blob.preview).length).toBeLessThan(80)
  })

  it('leaves normal text and prompts unchanged', () => {
    const prompt = '中文提示词，含标点。'.repeat(30)
    const out = sanitizeModelInvocationDetailsForLog({ prompt }) as Record<string, unknown>
    expect(out.prompt).toBe(prompt)
  })
})
