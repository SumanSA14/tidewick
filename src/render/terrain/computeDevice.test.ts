import { afterEach, describe, expect, it, vi } from 'vitest'
import { getComputeDevice, resetComputeDeviceForTests } from './erosionGPU'

/**
 * The compute device is requested by whoever asks first, and everyone who asks
 * while that request is in flight must get the same answer. The bug this
 * guards against: a flag set before the await told the second caller "no
 * device", and the second caller was the Stage that survived StrictMode.
 */

function fakeGPU(adapterDelayMs: number, adapter: boolean = true) {
  let requests = 0
  const device = { lost: new Promise<never>(() => {}), label: 'fake' }
  const gpu = {
    requestAdapter: async () => {
      requests++
      await new Promise((r) => setTimeout(r, adapterDelayMs))
      return adapter ? { requestDevice: async () => device } : null
    },
  }
  return { gpu, device, count: () => requests }
}

describe('getComputeDevice', () => {
  afterEach(() => {
    resetComputeDeviceForTests()
    vi.unstubAllGlobals()
  })

  it('gives concurrent callers the same device from one adapter request', async () => {
    const fake = fakeGPU(20)
    vi.stubGlobal('navigator', { gpu: fake.gpu })
    const [a, b, c] = await Promise.all([getComputeDevice(), getComputeDevice(), getComputeDevice()])
    expect(a).toBe(fake.device)
    expect(b).toBe(fake.device)
    expect(c).toBe(fake.device)
    expect(fake.count()).toBe(1)
  })

  it('returns null without WebGPU and does not throw', async () => {
    vi.stubGlobal('navigator', {})
    await expect(getComputeDevice()).resolves.toBeNull()
  })

  it('returns null when there is no adapter, for every concurrent caller', async () => {
    const fake = fakeGPU(5, false)
    vi.stubGlobal('navigator', { gpu: fake.gpu })
    const results = await Promise.all([getComputeDevice(), getComputeDevice()])
    expect(results).toEqual([null, null])
    expect(fake.count()).toBe(1)
  })
})
