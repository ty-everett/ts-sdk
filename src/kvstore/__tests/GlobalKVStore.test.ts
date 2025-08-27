/** eslint-env jest */
import GlobalKVStore from '../GlobalKVStore.js'
import LockingScript from '../../script/LockingScript.js'
import PushDrop from '../../script/templates/PushDrop.js'
import * as Utils from '../../primitives/utils.js'
import Hash from '../../primitives/Hash.js'
import {
  WalletInterface,
  WalletDecryptResult,
  WalletEncryptResult,
  CreateActionResult,
  SignActionResult,
  WalletHmacResult
} from '../../wallet/Wallet.interfaces.js'
import Transaction from '../../transaction/Transaction.js'
import { Beef } from '../../transaction/Beef.js'
import TopicBroadcaster from '../../broadcast/TopicBroadcaster.js'
import LookupResolver from '../../lookup/LookupResolver.js'

// --- Mock Constants ---
const testLockingScriptHex = 'mockLockingScriptHex'
const testUnlockingScriptHex = 'mockUnlockingScriptHex'
const testEncryptedValue = new Uint8Array([1, 2, 3, 4])
const testRawValue = 'myTestValue'
const testProtectedKey = 'dGVzdFByb3RlY3RlZEtleTE2Qnl0ZXM='
const testTxid = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
const testBeef = new Beef()

// --- Mock Dependencies ---
jest.mock('../../script/LockingScript.js', () => ({
  fromHex: jest.fn(() => ({
    toHex: jest.fn(() => testLockingScriptHex)
  }))
}))

jest.mock('../../script/templates/PushDrop.js', () => {
  const mockLockingScript = {
    toHex: jest.fn(() => testLockingScriptHex)
  }
  const mockUnlocker = {
    sign: jest.fn().mockResolvedValue({
      toHex: jest.fn(() => testUnlockingScriptHex)
    })
  }
  const mockPushDropInstance = {
    lock: jest.fn().mockResolvedValue(mockLockingScript),
    unlock: jest.fn().mockReturnValue(mockUnlocker)
  }
  const MockedPushDrop = jest.fn(() => mockPushDropInstance)
  MockedPushDrop.decode = jest.fn()
  return MockedPushDrop
})

jest.mock('../../primitives/utils.js', () => ({
  toArray: jest.fn((str: string, encoding = 'utf8') => {
    if (encoding === 'base64') {
      return Array.from(Buffer.from(str, 'base64'))
    }
    return Array.from(Buffer.from(str, encoding as BufferEncoding))
  }),
  toUTF8: jest.fn((arr: number[] | Uint8Array) => Buffer.from(arr).toString('utf8')),
  toBase64: jest.fn((arr: number[] | Uint8Array) => Buffer.from(arr).toString('base64'))
}))

jest.mock('../../primitives/Hash.js', () => ({
  sha256: jest.fn(() => new Uint8Array(32)),
  sha256hmac: jest.fn(() => new Uint8Array(32))
}))

jest.mock('../../transaction/Transaction.js', () => ({
  fromBEEF: jest.fn(),
  fromAtomicBEEF: jest.fn(() => ({
    id: jest.fn(() => testTxid),
    outputs: [{ lockingScript: { toHex: () => testLockingScriptHex }, satoshis: 1000 }]
  }))
}))

jest.mock('../../broadcast/TopicBroadcaster.js', () => {
  return jest.fn().mockImplementation(() => ({
    broadcast: jest.fn().mockResolvedValue({ success: true })
  }))
})

jest.mock('../../lookup/LookupResolver.js', () => {
  return jest.fn().mockImplementation(() => ({
    query: jest.fn()
  }))
})

jest.mock('../../wallet/WalletClient.js', () => jest.fn())

// --- Typed Mocks ---
const MockedPushDrop = PushDrop as jest.MockedClass<typeof PushDrop> & {
  decode: jest.Mock
}
const MockedUtils = Utils as jest.Mocked<typeof Utils>
const MockedTransaction = Transaction as jest.Mocked<typeof Transaction>
const MockedTopicBroadcaster = TopicBroadcaster as jest.MockedClass<typeof TopicBroadcaster>
const MockedLookupResolver = LookupResolver as jest.MockedClass<typeof LookupResolver>

// --- Mock Wallet Setup ---
const createMockWallet = (): jest.Mocked<WalletInterface> => ({
  getNetwork: jest.fn().mockResolvedValue({ network: 'mainnet' }),
  createHmac: jest.fn().mockResolvedValue({ hmac: new Uint8Array(32) } as WalletHmacResult),
  encrypt: jest.fn().mockResolvedValue({ ciphertext: testEncryptedValue } as WalletEncryptResult),
  decrypt: jest.fn().mockResolvedValue({ plaintext: new Uint8Array(Buffer.from(testRawValue)) } as WalletDecryptResult),
  createAction: jest.fn().mockResolvedValue({
    txid: testTxid,
    tx: new Uint8Array([1, 2, 3]),
    signableTransaction: {
      tx: new Uint8Array([1, 2, 3]),
      reference: 'ref123'
    }
  } as CreateActionResult),
  signAction: jest.fn().mockResolvedValue({
    txid: testTxid,
    tx: new Uint8Array([1, 2, 3])
  } as SignActionResult)
} as jest.Mocked<WalletInterface>)

describe('GlobalKVStore', () => {
  let mockWallet: jest.Mocked<WalletInterface>
  let kvStore: GlobalKVStore
  let mockResolver: jest.Mocked<InstanceType<typeof LookupResolver>>
  let mockBroadcaster: jest.Mocked<InstanceType<typeof TopicBroadcaster>>

  const testKey = 'testKey'
  const testValue = 'testValue'

  beforeEach(() => {
    jest.clearAllMocks()

    mockWallet = createMockWallet()
    
    // Setup resolver mock
    mockResolver = {
      query: jest.fn().mockResolvedValue({
        type: 'output-list',
        outputs: []
      })
    } as any
    MockedLookupResolver.mockImplementation(() => mockResolver)

    // Setup broadcaster mock
    mockBroadcaster = {
      broadcast: jest.fn().mockResolvedValue({ success: true })
    } as any
    MockedTopicBroadcaster.mockImplementation(() => mockBroadcaster)

    kvStore = new GlobalKVStore({ wallet: mockWallet })

    // Setup PushDrop decode mock
    MockedPushDrop.decode.mockReturnValue({
      fields: [
        new Uint8Array(32), // protected key
        testEncryptedValue,  // encrypted value
        new Uint8Array([0])  // signature
      ]
    })
  })

  describe('constructor', () => {
    it('should create instance with default configuration', () => {
      const store = new GlobalKVStore()
      expect(store).toBeInstanceOf(GlobalKVStore)
      expect(store.acceptDelayedBroadcast).toBe(false)
    })

    it('should create instance with custom configuration', () => {
      const config = {
        wallet: mockWallet,
        protocolID: [1, 'custom'] as [number, string],
        encrypt: false,
        tokenAmount: 2000
      }
      const store = new GlobalKVStore(config)
      expect(store).toBeInstanceOf(GlobalKVStore)
    })

    it('should throw error if both sendToCounterparty and receiveFromCounterparty are true', () => {
      expect(() => new GlobalKVStore({
        sendToCounterparty: true,
        receiveFromCounterparty: true
      })).toThrow('sendToCounterparty and receiveFromCounterparty cannot both be true at the same time.')
    })

    it('should throw error if protocolID is empty string', () => {
      expect(() => new GlobalKVStore({
        protocolID: ''
      })).toThrow('Protocol ID cannot be an empty string.')
    })
  })

  describe('get method', () => {
    it('should throw error for invalid key', async () => {
      await expect(kvStore.get('')).rejects.toThrow('Key must be a non-empty string.')
      await expect(kvStore.get(null as any)).rejects.toThrow('Key must be a non-empty string.')
    })

    it('should return default value when key not found', async () => {
      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: []
      })

      const result = await kvStore.get(testKey, 'default')
      expect(result).toBe('default')
    })

    it('should return decrypted value when key exists', async () => {
      const mockOutput = {
        beef: testBeef,
        outputIndex: 0,
        satoshis: 1000
      }

      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: [mockOutput]
      })

      MockedTransaction.fromBEEF.mockReturnValue({
        id: jest.fn(() => testTxid),
        outputs: [{
          lockingScript: { toHex: () => testLockingScriptHex },
          satoshis: 1000
        }]
      } as any)

      const result = await kvStore.get(testKey)
      expect(result).toBe(testRawValue)
      expect(mockWallet.decrypt).toHaveBeenCalled()
    })

    it('should return history when requested', async () => {
      const mockOutput = {
        beef: testBeef,
        outputIndex: 0,
        satoshis: 1000
      }

      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: [mockOutput]
      })

      MockedTransaction.fromBEEF.mockReturnValue({
        id: jest.fn(() => testTxid),
        outputs: [{
          lockingScript: { toHex: () => testLockingScriptHex },
          satoshis: 1000
        }],
        inputs: [] // No history for simplicity
      } as any)

      const result = await kvStore.get(testKey, undefined, true)
      expect(typeof result).toBe('object')
      expect((result as any).value).toBe(testRawValue)
      expect((result as any).valueHistory).toEqual([testRawValue])
    })
  })

  describe('set method', () => {
    it('should throw error for invalid parameters', async () => {
      await expect(kvStore.set('', testValue)).rejects.toThrow('Key must be a non-empty string.')
      await expect(kvStore.set(testKey, null as any)).rejects.toThrow('Value must be a string.')
    })

    it('should create new token when key does not exist', async () => {
      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: []
      })

      const result = await kvStore.set(testKey, testValue)
      
      expect(mockWallet.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          description: `Create KVStore value for ${testKey}`,
          outputs: expect.arrayContaining([
            expect.objectContaining({
              satoshis: 1000,
              outputDescription: 'KVStore token'
            })
          ])
        })
      )
      expect(result).toBe(`${testTxid}.0`)
    })

    it('should update existing token when key exists', async () => {
      const mockOutput = {
        beef: testBeef,
        outputIndex: 0,
        satoshis: 1000
      }

      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: [mockOutput]
      })

      MockedTransaction.fromBEEF.mockReturnValue({
        id: jest.fn(() => testTxid),
        outputs: [{
          lockingScript: { toHex: () => testLockingScriptHex },
          satoshis: 1000
        }]
      } as any)

      const result = await kvStore.set(testKey, testValue)
      
      expect(mockWallet.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          description: `Update KVStore value for ${testKey}`,
          inputs: expect.arrayContaining([
            expect.objectContaining({
              inputDescription: 'Previous KVStore token'
            })
          ])
        })
      )
      expect(mockWallet.signAction).toHaveBeenCalled()
      expect(result).toBe(`${testTxid}.0`)
    })
  })

  describe('remove method', () => {
    it('should throw error for invalid key', async () => {
      await expect(kvStore.remove('')).rejects.toThrow('Key must be a non-empty string.')
    })

    it('should throw error when key does not exist', async () => {
      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: []
      })

      await expect(kvStore.remove(testKey)).rejects.toThrow('The item did not exist, no item was deleted.')
    })

    it('should remove existing token', async () => {
      const mockOutput = {
        beef: testBeef,
        outputIndex: 0,
        satoshis: 1000
      }

      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: [mockOutput]
      })

      MockedTransaction.fromBEEF.mockReturnValue({
        id: jest.fn(() => testTxid),
        outputs: [{
          lockingScript: { toHex: () => testLockingScriptHex },
          satoshis: 1000
        }]
      } as any)

      const result = await kvStore.remove(testKey)
      
      expect(mockWallet.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          description: `Remove KVStore value for ${testKey}`,
          inputs: expect.arrayContaining([
            expect.objectContaining({
              inputDescription: 'KVStore token to remove'
            })
          ])
        })
      )
      expect(mockWallet.signAction).toHaveBeenCalled()
      expect(result).toEqual([testTxid])
    })
  })

  describe('getWithHistory method', () => {
    it('should return undefined when key not found', async () => {
      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: []
      })

      const result = await kvStore.getWithHistory(testKey)
      expect(result).toBeUndefined()
    })

    it('should return history object when key exists', async () => {
      const mockOutput = {
        beef: testBeef,
        outputIndex: 0,
        satoshis: 1000
      }

      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: [mockOutput]
      })

      MockedTransaction.fromBEEF.mockReturnValue({
        id: jest.fn(() => testTxid),
        outputs: [{
          lockingScript: { toHex: () => testLockingScriptHex },
          satoshis: 1000
        }],
        inputs: []
      } as any)

      const result = await kvStore.getWithHistory(testKey)
      expect(result).toBeDefined()
      expect(result!.value).toBe(testRawValue)
      expect(result!.valueHistory).toEqual([testRawValue])
    })
  })

  describe('atomic operations', () => {
    it('should handle concurrent operations on the same key', async () => {
      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: []
      })

      // Simulate concurrent operations
      const promise1 = kvStore.set(testKey, 'value1')
      const promise2 = kvStore.set(testKey, 'value2')

      const [result1, result2] = await Promise.all([promise1, promise2])
      
      // Both should succeed and return valid outpoints
      expect(result1).toMatch(/^[a-f0-9]{64}\.0$/)
      expect(result2).toMatch(/^[a-f0-9]{64}\.0$/)
    })
  })

  describe('error handling', () => {
    it('should handle double spend errors with retry', async () => {
      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: []
      })

      // First call fails with double spend, second succeeds
      mockWallet.createAction
        .mockRejectedValueOnce({ code: 'ERR_DOUBLE_SPEND' })
        .mockResolvedValueOnce({
          txid: testTxid,
          tx: new Uint8Array([1, 2, 3])
        } as CreateActionResult)

      const result = await kvStore.set(testKey, testValue)
      expect(result).toBe(`${testTxid}.0`)
      expect(mockWallet.createAction).toHaveBeenCalledTimes(2)
    })

    it('should throw error after max retry attempts', async () => {
      mockResolver.query.mockResolvedValue({
        type: 'output-list',
        outputs: []
      })

      mockWallet.createAction.mockRejectedValue({ code: 'ERR_DOUBLE_SPEND' })

      await expect(kvStore.set(testKey, testValue)).rejects.toThrow()
    })
  })
})
