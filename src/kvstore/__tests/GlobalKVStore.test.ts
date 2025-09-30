/** eslint-env jest */

import GlobalKVStore, { KVStoreConfig, KVStoreToken } from '../GlobalKVStore.js'
import { WalletInterface, CreateActionResult, SignActionResult } from '../../wallet/Wallet.interfaces.js'
import Transaction from '../../transaction/Transaction.js'
import { Beef } from '../../transaction/Beef.js'
import { Historian } from '../../overlay-tools/Historian.js'
import { kvStoreInterpreter } from '../kvStoreInterpreter.js'
import { PushDrop } from '../../script/index.js'
import * as Utils from '../../primitives/utils.js'
import { TopicBroadcaster, LookupResolver } from '../../overlay-tools/index.js'
import { ProtoWallet } from '../../wallet/ProtoWallet.js'
import { kvProtocol } from '../types.js'

// --- Module mocks ------------------------------------------------------------
jest.mock('../../transaction/Transaction.js')
jest.mock('../../transaction/Beef.js')
jest.mock('../../overlay-tools/Historian.js')
jest.mock('../kvStoreInterpreter.js')
jest.mock('../../script/index.js')
jest.mock('../../primitives/utils.js')
jest.mock('../../overlay-tools/index.js')
jest.mock('../../wallet/ProtoWallet.js')
jest.mock('../../wallet/WalletClient.js')

// --- Typed shortcuts to mocked classes --------------------------------------
const MockTransaction = Transaction as jest.MockedClass<typeof Transaction>
const MockBeef = Beef as jest.MockedClass<typeof Beef>
const MockHistorian = Historian as jest.MockedClass<typeof Historian>
const MockPushDrop = PushDrop as jest.MockedClass<typeof PushDrop>
const MockUtils = Utils as jest.Mocked<typeof Utils>
const MockTopicBroadcaster = TopicBroadcaster as jest.MockedClass<typeof TopicBroadcaster>
const MockLookupResolver = LookupResolver as jest.MockedClass<typeof LookupResolver>
const MockProtoWallet = ProtoWallet as jest.MockedClass<typeof ProtoWallet>

// --- Test constants ----------------------------------------------------------
const TEST_TXID =
  '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
const TEST_PROTECTED_KEY = 'dGVzdFByb3RlY3RlZEtleTE2Qnl0ZXM='
const TEST_CONTROLLER =
  '02e3f2c4a5b6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3'
const TEST_KEY = 'testKey'
const TEST_VALUE = 'testValue'

// --- Helpers ----------------------------------------------------------------
type MTx = jest.Mocked<InstanceType<typeof Transaction>>
type MBeef = jest.Mocked<InstanceType<typeof Beef>> & { findOutput: jest.Mock }
type MHistorian = jest.Mocked<InstanceType<typeof Historian>>
type MResolver = jest.Mocked<InstanceType<typeof LookupResolver>>
type MBroadcaster = jest.Mocked<InstanceType<typeof TopicBroadcaster>>
type MProtoWallet = jest.Mocked<InstanceType<typeof ProtoWallet>>

function makeMockTx(): MTx {
  return {
    id: jest.fn().mockReturnValue(TEST_TXID),
    // Only the properties used by GlobalKVStore are needed
    outputs: [
      {
        lockingScript: {
          toHex: jest.fn().mockReturnValue('mock_script'),
          toArray: jest.fn().mockReturnValue([1, 2, 3]),
        },
        satoshis: 1000,
      },
    ],
    inputs: [],
  } as any
}

function primeTransactionMocks(tx: MTx) {
  ; (MockTransaction.fromAtomicBEEF as jest.Mock).mockReturnValue(tx)
    ; (MockTransaction.fromBEEF as jest.Mock).mockReturnValue(tx)
}

function primeBeefMocks(beef: MBeef, tx: MTx) {
  beef.toBinary.mockReturnValue(Array.from(new Uint8Array([1, 2, 3])))
  beef.findTxid.mockReturnValue({ tx } as any)
  beef.findOutput = jest.fn().mockReturnValue(tx.outputs[0] as any)
  MockBeef.mockImplementation(() => beef)
    ; (MockBeef as any).fromBinary = jest.fn().mockReturnValue(beef)
}

function primePushDropDecodeToValidValue() {
  ; (MockPushDrop as any).decode = jest.fn().mockReturnValue({
    fields: [
      Array.from(Buffer.from(JSON.stringify([1, 'kvstore']))), // namespace
      Array.from(new Uint8Array(32)), // protectedKey
      Array.from(Buffer.from(TEST_VALUE)), // value
      Array.from(Buffer.from('controller')), // controller
      Array.from(Buffer.from('signature')), // signature
    ],
  })
}

function primeUtilsDefaults() {
  MockUtils.toUTF8.mockImplementation((arr: any) => {
    if (typeof arr === 'string') return arr
    // the JSON for [1,"kvstore"] encoded to bytes
    if (
      Array.isArray(arr) &&
      arr.join(',') === '91,49,44,34,107,118,115,116,111,114,101,34,93'
    ) {
      return '[1,"kvstore"]'
    }
    return TEST_VALUE
  })
  MockUtils.toBase64.mockReturnValue(TEST_PROTECTED_KEY)
  MockUtils.toArray.mockReturnValue([1, 2, 3, 4])
}

function primeWalletMocks() {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: TEST_CONTROLLER }),
    createAction: jest.fn().mockResolvedValue({
      tx: Array.from(new Uint8Array([1, 2, 3])),
      txid: TEST_TXID,
      signableTransaction: {
        tx: Array.from(new Uint8Array([1, 2, 3])),
        reference: 'ref123',
      },
    } as CreateActionResult),
    signAction: jest.fn().mockResolvedValue({
      tx: Array.from(new Uint8Array([1, 2, 3])),
      txid: TEST_TXID,
    } as SignActionResult),
  } as unknown as jest.Mocked<WalletInterface>
}

function primeResolverEmpty(resolver: MResolver) {
  resolver.query.mockResolvedValue({ type: 'output-list', outputs: [] } as any)
}

function primeResolverWithOneOutput(resolver: MResolver) {
  const mockOutput = {
    beef: Array.from(new Uint8Array([1, 2, 3])),
    outputIndex: 0,
    context: Array.from(new Uint8Array([4, 5, 6])),
  }
  resolver.query.mockResolvedValue({
    type: 'output-list',
    outputs: [mockOutput],
  } as any)
}

// --- Test suite --------------------------------------------------------------
describe('GlobalKVStore', () => {
  let kvStore: GlobalKVStore
  let mockWallet: jest.Mocked<WalletInterface>
  let mockHistorian: MHistorian
  let mockResolver: MResolver
  let mockBroadcaster: MBroadcaster
  let mockBeef: MBeef
  let mockProtoWallet: MProtoWallet
  let tx: MTx

  beforeEach(() => {
    jest.clearAllMocks()

    // Wallet
    mockWallet = primeWalletMocks()

    // Tx/BEEF
    tx = makeMockTx()
    primeTransactionMocks(tx)
    mockBeef = {
      toBinary: jest.fn(),
      findTxid: jest.fn(),
      findOutput: jest.fn(),
    } as any
    primeBeefMocks(mockBeef, tx)

    // Historian
    mockHistorian = {
      buildHistory: jest.fn().mockResolvedValue([TEST_VALUE]),
    } as any
    MockHistorian.mockImplementation(() => mockHistorian)

    // PushDrop lock/unlock plumbing
    const mockLockingScript = { toHex: () => 'mockLockingScriptHex' }
    const mockPushDrop = {
      lock: jest.fn().mockResolvedValue(mockLockingScript),
      unlock: jest.fn().mockReturnValue({
        sign: jest.fn().mockResolvedValue({ toHex: () => 'mockUnlockingScript' }),
      }),
    }
    MockPushDrop.mockImplementation(() => mockPushDrop as any)
    primePushDropDecodeToValidValue()

    // Utils
    primeUtilsDefaults()

    // Resolver / Broadcaster
    mockResolver = {
      query: jest.fn(),
    } as any
    MockLookupResolver.mockImplementation(() => mockResolver)
    mockBroadcaster = {
      broadcast: jest.fn().mockResolvedValue({ success: true }),
    } as any
    MockTopicBroadcaster.mockImplementation(() => mockBroadcaster)

    // Proto wallet
    mockProtoWallet = {
      createHmac: jest.fn().mockResolvedValue({ hmac: new Uint8Array(32) }),
      verifySignature: jest.fn().mockResolvedValue({ valid: true }),
    } as any
    MockProtoWallet.mockImplementation(() => mockProtoWallet)

    // SUT
    kvStore = new GlobalKVStore({ wallet: mockWallet })
  })

  // --------------------------------------------------------------------------
  describe('Constructor', () => {
    it('creates with default config', () => {
      const store = new GlobalKVStore()
      expect(store).toBeInstanceOf(GlobalKVStore)
    })

    it('creates with custom config', () => {
      const config: KVStoreConfig = {
        wallet: mockWallet,
        protocolID: [2, 'custom'],
        tokenAmount: 500,
        networkPreset: 'testnet',
      }
      const store = new GlobalKVStore(config)
      expect(store).toBeInstanceOf(GlobalKVStore)
    })

    it('initializes Historian with kvStoreInterpreter', () => {
      expect(MockHistorian).toHaveBeenCalledWith(kvStoreInterpreter)
    })
  })

  // --------------------------------------------------------------------------
  describe('get', () => {
    describe('happy paths', () => {
      it('returns undefined when key not found and no default', async () => {
        primeResolverEmpty(mockResolver)

        const result = await kvStore.get(TEST_KEY)

        expect(result).toBeUndefined()
      })

      it('returns provided default when key not found', async () => {
        primeResolverEmpty(mockResolver)

        const result = await kvStore.get(TEST_KEY, 'defaultValue')

        expect(result).toBe('defaultValue')
      })

      it('returns current value when a valid token exists', async () => {
        primeResolverWithOneOutput(mockResolver)

        const result = await kvStore.get(TEST_KEY)

        expect(result).toBe(TEST_VALUE)
        expect(mockResolver.query).toHaveBeenCalledWith({
          service: 'ls_kvstore',
          query: expect.objectContaining({
            protectedKey: TEST_PROTECTED_KEY,
            controller: TEST_CONTROLLER,
          }),
        })
      })

      it('returns value + history when history=true', async () => {
        primeResolverWithOneOutput(mockResolver)
        mockHistorian.buildHistory.mockResolvedValue(['oldValue', TEST_VALUE])

        const result = await kvStore.get(TEST_KEY, undefined, undefined, true)

        expect(result).toEqual({
          token: expect.objectContaining({
            txid: TEST_TXID,
            outputIndex: 0,
            satoshis: 1000,
          }),
          value: TEST_VALUE,
          valueHistory: ['oldValue', TEST_VALUE],
        })
        expect(mockHistorian.buildHistory).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ protectedKey: TEST_PROTECTED_KEY })
        )
      })

      it('supports custom controller (derives HMAC with ProtoWallet)', async () => {
        primeResolverEmpty(mockResolver)
        const customController =
          '03abcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234'

        await kvStore.get(TEST_KEY, undefined, customController)

        expect(MockProtoWallet).toHaveBeenCalledWith('anyone')
        expect(mockProtoWallet.createHmac).toHaveBeenCalled()
      })
    })

    describe('sad paths', () => {
      it('rejects empty key', async () => {
        await expect(kvStore.get('')).rejects.toThrow('Key must be a non-empty string.')
      })

      it('rejects non-string key', async () => {
        await expect(kvStore.get(null as any)).rejects.toThrow('Key must be a non-empty string.')
        await expect(kvStore.get(undefined as any)).rejects.toThrow('Key must be a non-empty string.')
      })

      it('propagates overlay errors', async () => {
        mockResolver.query.mockRejectedValue(new Error('Network error'))

        await expect(kvStore.get(TEST_KEY)).rejects.toThrow('Network error')
      })

      it('skips malformed candidates and returns default (invalid PushDrop format)', async () => {
        primeResolverWithOneOutput(mockResolver)

        const originalDecode = (MockPushDrop as any).decode
          ; (MockPushDrop as any).decode = jest.fn(() => {
            throw new Error('Invalid PushDrop format')
          })

        try {
          const result = await kvStore.get(TEST_KEY, 'default')
          expect(result).toBe('default')
        } finally {
          ; (MockPushDrop as any).decode = originalDecode
        }
      })
    })
  })

  // --------------------------------------------------------------------------
  describe('set', () => {
    describe('happy paths', () => {
      it('creates a new token when key does not exist', async () => {
        primeResolverEmpty(mockResolver)

        const outpoint = await kvStore.set(TEST_KEY, TEST_VALUE)

        expect(mockWallet.createAction).toHaveBeenCalledWith(
          expect.objectContaining({
            description: `Create KVStore value for ${TEST_KEY}`,
            outputs: expect.arrayContaining([
              expect.objectContaining({
                satoshis: 1,
                outputDescription: 'KVStore token',
              }),
            ]),
          })
        )
        expect(outpoint).toBe(`${TEST_TXID}.0`)
        expect(mockBroadcaster.broadcast).toHaveBeenCalled()
      })

      it('updates existing token when one exists', async () => {
        primeResolverWithOneOutput(mockResolver)

        const outpoint = await kvStore.set(TEST_KEY, TEST_VALUE)

        expect(mockWallet.createAction).toHaveBeenCalledWith(
          expect.objectContaining({
            description: `Update KVStore value for ${TEST_KEY}`,
            inputs: expect.arrayContaining([
              expect.objectContaining({
                inputDescription: 'Previous KVStore token',
              }),
            ]),
          })
        )
        expect(mockWallet.signAction).toHaveBeenCalled()
        expect(outpoint).toBe(`${TEST_TXID}.0`)
      })

      it('is safe under concurrent operations (key locking)', async () => {
        primeResolverEmpty(mockResolver)

        const [r1, r2] = await Promise.all([
          kvStore.set(TEST_KEY, 'value1'),
          kvStore.set(TEST_KEY, 'value2'),
        ])

        expect(r1).toMatch(/^[a-f0-9]{64}\.0$/)
        expect(r2).toMatch(/^[a-f0-9]{64}\.0$/)
      })
    })

    describe('sad paths', () => {
      it('rejects invalid key', async () => {
        await expect(kvStore.set('', TEST_VALUE)).rejects.toThrow('Key must be a non-empty string.')
        await expect(kvStore.set(null as any, TEST_VALUE)).rejects.toThrow('Key must be a non-empty string.')
      })

      it('rejects invalid value', async () => {
        await expect(kvStore.set(TEST_KEY, null as any)).rejects.toThrow('Value must be a string.')
        await expect(kvStore.set(TEST_KEY, undefined as any)).rejects.toThrow('Value must be a string.')
      })

      it('propagates wallet createAction failures', async () => {
        primeResolverEmpty(mockResolver)
          ; (mockWallet.createAction as jest.Mock).mockRejectedValue(new Error('Wallet error'))

        await expect(kvStore.set(TEST_KEY, TEST_VALUE)).rejects.toThrow('Wallet error')
      })

      it('propagates broadcast failures', async () => {
        primeResolverEmpty(mockResolver)
          ; (mockBroadcaster.broadcast as jest.Mock).mockRejectedValue(new Error('Broadcast failed'))

        await expect(kvStore.set(TEST_KEY, TEST_VALUE)).rejects.toThrow('Broadcast failed')
      })
    })
  })

  // --------------------------------------------------------------------------
  describe('remove', () => {
    describe('happy paths', () => {
      it('removes an existing token', async () => {
        primeResolverWithOneOutput(mockResolver)

        const txid = await kvStore.remove(TEST_KEY)

        expect(mockWallet.createAction).toHaveBeenCalledWith(
          expect.objectContaining({
            description: `Remove KVStore value for ${TEST_KEY}`,
            inputs: expect.arrayContaining([
              expect.objectContaining({
                inputDescription: 'KVStore token to remove',
              }),
            ]),
          })
        )
        expect(mockWallet.signAction).toHaveBeenCalled()
        expect(txid).toBe(TEST_TXID)
      })

      it('supports custom outputs on removal', async () => {
        primeResolverWithOneOutput(mockResolver)

        const customOutputs = [
          {
            satoshis: 500,
            lockingScript: 'customScript',
            outputDescription: 'Custom output',
          },
        ]

        const txid = await kvStore.remove(TEST_KEY, customOutputs)

        expect(mockWallet.createAction).toHaveBeenCalledWith(
          expect.objectContaining({
            outputs: customOutputs,
          })
        )
        expect(txid).toBe(TEST_TXID)
      })
    })

    describe('sad paths', () => {
      it('rejects invalid key', async () => {
        await expect(kvStore.remove('')).rejects.toThrow('Key must be a non-empty string.')
      })

      it('throws when key does not exist', async () => {
        primeResolverEmpty(mockResolver)

        await expect(kvStore.remove(TEST_KEY)).rejects.toThrow(
          'The item did not exist, no item was deleted.'
        )
      })

      it('propagates wallet signAction failures', async () => {
        primeResolverWithOneOutput(mockResolver)
          ; (mockWallet.signAction as jest.Mock).mockRejectedValue(new Error('Sign failed'))

        await expect(kvStore.remove(TEST_KEY)).rejects.toThrow('Sign failed')
      })
    })
  })

  // --------------------------------------------------------------------------
  describe('getWithHistory', () => {
    it('delegates to get(key, undefined, controller, true) and returns value + history', async () => {
      primeResolverWithOneOutput(mockResolver)
      mockHistorian.buildHistory.mockResolvedValue([TEST_VALUE])

      const result = await kvStore.getWithHistory(TEST_KEY)

      expect(result).toEqual({
        token: expect.any(Object),
        value: TEST_VALUE,
        valueHistory: [TEST_VALUE],
      })
    })

    it('returns undefined when key not found', async () => {
      primeResolverEmpty(mockResolver)

      const result = await kvStore.getWithHistory(TEST_KEY)
      expect(result).toBeUndefined()
    })
  })

  // --------------------------------------------------------------------------
  describe('Integration-ish behaviors', () => {
    it('generates protected keys with expected inputs to ProtoWallet.createHmac', async () => {
      primeResolverEmpty(mockResolver)

      await kvStore.set(TEST_KEY, TEST_VALUE)

      expect(MockProtoWallet).toHaveBeenCalledWith('anyone')
      expect(mockProtoWallet.createHmac).toHaveBeenCalledWith({
        protocolID: [1, 'kvstore'],
        keyID: TEST_KEY,
        counterparty: TEST_CONTROLLER,
        data: [1, 2, 3, 4],
      })
    })

    it('caches identity key (single wallet.getPublicKey call across operations)', async () => {
      primeResolverEmpty(mockResolver)

      await kvStore.set('key1', 'value1')
      await kvStore.set('key2', 'value2')

      expect(mockWallet.getPublicKey).toHaveBeenCalledTimes(1)
    })
  })

  // --------------------------------------------------------------------------
  describe('Error recovery & edge cases', () => {
    it('returns fallback default for empty overlay response', async () => {
      primeResolverEmpty(mockResolver)

      const result = await kvStore.get(TEST_KEY, 'fallback')
      expect(result).toBe('fallback')
    })

    it('skips malformed transactions and returns fallback default', async () => {
      primeResolverWithOneOutput(mockResolver)

      const originalFromBEEF = (MockTransaction as any).fromBEEF
        ; (MockTransaction as any).fromBEEF = jest.fn(() => {
          throw new Error('Malformed transaction data')
        })

      try {
        const result = await kvStore.get(TEST_KEY, 'fallback')
        expect(result).toBe('fallback')
      } finally {
        ; (MockTransaction as any).fromBEEF = originalFromBEEF
      }
    })

    it('handles edge cases where no valid tokens pass full validation', async () => {
      // This test verifies that when tokens exist but fail validation (signature, etc),
      // the method gracefully returns undefined/default rather than throwing
      primeResolverWithOneOutput(mockResolver)
      
      // Make signature verification fail (this could be a realistic failure mode)
      const originalVerifySignature = mockProtoWallet.verifySignature
      mockProtoWallet.verifySignature = jest.fn().mockResolvedValue({ valid: false })

      try {
        const result = await kvStore.get(TEST_KEY, 'fallback', undefined, true)
        expect(result).toBe('fallback')
      } finally {
        // Restore original mock
        mockProtoWallet.verifySignature = originalVerifySignature
      }
    })

    it('when no valid outputs (decode fails), get(..., history=true) still returns default', async () => {
      primeResolverWithOneOutput(mockResolver)

      const originalDecode = (MockPushDrop as any).decode
        ; (MockPushDrop as any).decode = jest.fn(() => {
          throw new Error('Invalid token format')
        })

      try {
        const result = await kvStore.get(TEST_KEY, 'fallback', undefined, true)
        expect(result).toBe('fallback')
      } finally {
        ; (MockPushDrop as any).decode = originalDecode
      }
    })
  })
})
