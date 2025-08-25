import LivePolicy from '../LivePolicy.js'

describe('LivePolicy', () => {
  beforeEach(() => {
    // Reset singleton instance before each test
    ;(LivePolicy as any).instance = null
  })

  it('should return the same instance when getInstance is called multiple times', () => {
    const instance1 = LivePolicy.getInstance()
    const instance2 = LivePolicy.getInstance()
    
    expect(instance1).toBe(instance2)
    expect(instance1).toBeInstanceOf(LivePolicy)
  })

  it('should share cache between singleton instances', async () => {
    const instance1 = LivePolicy.getInstance()
    const instance2 = LivePolicy.getInstance()
    
    // Mock fetch to return a specific rate
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        policy: {
          miningFee: {
            satoshis: 5,
            bytes: 1000
          }
        }
      })
    })

    // Create a mock transaction
    const mockTx = {
      inputs: [],
      outputs: []
    } as any

    // First call should fetch from API
    const fee1 = await instance1.computeFee(mockTx)
    
    // Second call should use cached value (no additional fetch)
    const fee2 = await instance2.computeFee(mockTx)
    
    expect(fee1).toBe(fee2)
    expect(fee1).toBe(1) // 1 because rate is 5 sat/1000 bytes * 1000 = 5 sat/kb, and minimum tx size gets 1 sat
    expect(global.fetch).toHaveBeenCalledTimes(1) // Only called once due to caching
  })

  it('should allow different cache validity when creating singleton', () => {
    const instance1 = LivePolicy.getInstance(10000) // 10 seconds
    const instance2 = LivePolicy.getInstance(20000) // 20 seconds (should be ignored)
    
    expect(instance1).toBe(instance2)
    // The first call determines the cache validity
    expect((instance1 as any).cacheValidityMs).toBe(10000)
  })
})
