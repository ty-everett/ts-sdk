import LivePolicy from '../LivePolicy.js'

describe('LivePolicy', () => {
  beforeEach(() => {
    // Reset singleton instance before each test
    ;(LivePolicy as any).instance = null
    jest.clearAllMocks()
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

  it('should create instance with custom cache validity', () => {
    // Line 20: constructor with custom cacheValidityMs
    const instance = new LivePolicy(30000)
    expect((instance as any).cacheValidityMs).toBe(30000)
  })

  it('should handle HTTP error responses', async () => {
    const instance = LivePolicy.getInstance()
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
    
    // Mock fetch to return HTTP error - Lines 53, 54
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    })

    const mockTx = {
      inputs: [],
      outputs: []
    } as any

    const fee = await instance.computeFee(mockTx)
    
    expect(fee).toBe(1) // Should use default 100 sat/kb, minimum tx size gets 1 sat
    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to fetch live fee rate, using default 100 sat/kb:',
      expect.any(Error)
    )
    
    consoleSpy.mockRestore()
  })

  it('should handle invalid API response format', async () => {
    const instance = LivePolicy.getInstance()
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
    
    // Mock fetch to return invalid response format - Lines 59, 60
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        // Missing policy.miningFee structure
        invalid: 'response'
      })
    })

    const mockTx = {
      inputs: [],
      outputs: []
    } as any

    const fee = await instance.computeFee(mockTx)
    
    expect(fee).toBe(1) // Should use default 100 sat/kb, minimum tx size gets 1 sat
    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to fetch live fee rate, using default 100 sat/kb:',
      expect.any(Error)
    )
    
    consoleSpy.mockRestore()
  })

  it('should use cached value when API fails after successful fetch', async () => {
    const instance = LivePolicy.getInstance()
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
    
    // First call - successful fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        policy: {
          miningFee: {
            satoshis: 10,
            bytes: 1000
          }
        }
      })
    })

    const mockTx = {
      inputs: [],
      outputs: []
    } as any

    const fee1 = await instance.computeFee(mockTx)
    expect(fee1).toBe(1) // 10 sat/kb rate

    // Expire the cache by manipulating the timestamp
    ;(instance as any).cacheTimestamp = Date.now() - (6 * 60 * 1000) // 6 minutes ago

    // Second call - API fails, should use cached value - Lines 73, 74, 75
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'))
    
    const fee2 = await instance.computeFee(mockTx)
    
    expect(fee2).toBe(1) // Should use cached rate
    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to fetch live fee rate, using cached value:',
      expect.any(Error)
    )
    
    consoleSpy.mockRestore()
  })

  it('should handle network errors with no cached value', async () => {
    const instance = LivePolicy.getInstance()
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
    
    // Mock fetch to throw network error - Lines 79, 80
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'))

    const mockTx = {
      inputs: [],
      outputs: []
    } as any

    const fee = await instance.computeFee(mockTx)
    
    expect(fee).toBe(1) // Should use default 100 sat/kb, minimum tx size gets 1 sat
    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to fetch live fee rate, using default 100 sat/kb:',
      expect.any(Error)
    )
    
    consoleSpy.mockRestore()
  })
})
