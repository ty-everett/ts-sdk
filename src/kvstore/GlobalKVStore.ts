import Transaction from '../transaction/Transaction.js'
import * as Utils from '../primitives/utils.js'
import { TopicBroadcaster, LookupResolver } from '../overlay-tools/index.js'
import { BroadcastResponse, BroadcastFailure } from '../transaction/Broadcaster.js'
import { WalletInterface, CreateActionInput, OutpointString, PubKeyHex, CreateActionOutput, HexString } from '../wallet/Wallet.interfaces.js'
import { PushDrop } from '../script/index.js'
import WalletClient from '../wallet/WalletClient.js'
import { Beef } from '../transaction/Beef.js'
import { Historian } from '../overlay-tools/Historian.js'
import { KVContext, kvStoreInterpreter } from './kvStoreInterpreter.js'
import { ProtoWallet } from '../wallet/ProtoWallet.js'
import { kvProtocol, KVStoreConfig, KVStoreQuery, KVStoreToken } from './types.js'

/**
 * Default configuration values for GlobalKVStore operations.
 * Provides sensible defaults for overlay connection and protocol settings.
 */
const DEFAULT_CONFIG: Required<Omit<KVStoreConfig, 'wallet' | 'overlayHost' | 'originator'>> = {
  protocolID: [1, 'kvstore'],
  tokenAmount: 1,
  topics: ['tm_kvstore'],
  networkPreset: 'mainnet',
  acceptDelayedBroadcast: false
}

/**
 * Implements a global key-value storage system which uses an overlay service to track key-value pairs.
 * Each key-value pair is represented by a PushDrop token output.
 * Allows getting, setting, and removing key-value pairs with optional encryption and history tracking.
 */
export class GlobalKVStore {
  /**
   * The wallet interface used to create transactions and perform cryptographic operations.
   * @private
   * @readonly
   */
  private readonly wallet: WalletInterface

  /**
   * Configuration object containing overlay service settings and protocol parameters.
   * @private
   * @readonly
   */
  private readonly config: KVStoreConfig

  /**
   * Historian instance used to extract history from transaction outputs.
   * @private
   */
  private readonly historian: Historian<string>

  /**
   * A map to store locks for each key to ensure atomic updates.
   * @private
   */
  private readonly keyLocks: Map<string, Array<(value: void | PromiseLike<void>) => void>> = new Map()

  /**
   * Cached user identity key
   * @private
   */
  private cachedIdentityKey: PubKeyHex | null = null

  /**
   * Creates an instance of the GlobalKVStore.
   *
   * @param {KVStoreConfig} [config={}] - Configuration options for the KVStore. Defaults to empty object.
   * @throws {Error} If the configuration contains invalid parameters.
   */
  constructor (config: KVStoreConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.wallet = config.wallet ?? new WalletClient()
    this.historian = new Historian<string, KVContext>(kvStoreInterpreter)
  }

  /**
   * Queues an operation on a specific key to ensure atomic updates.
   * Prevents concurrent operations on the same key from interfering with each other.
   *
   * @param {string} key - The key to queue an operation for.
   * @returns {Promise<Array<(value: void | PromiseLike<void>) => void>>} The lock queue for cleanup.
   * @private
   */
  private async queueOperationOnKey (key: string): Promise<Array<(value: void | PromiseLike<void>) => void>> {
    // Check if a lock exists for this key and wait for it to resolve
    let lockQueue = this.keyLocks.get(key)
    if (lockQueue == null) {
      lockQueue = []
      this.keyLocks.set(key, lockQueue)
    }

    let resolveNewLock: () => void = () => { }
    const newLock = new Promise<void>((resolve) => {
      resolveNewLock = resolve
      if (lockQueue != null) { lockQueue.push(resolve) }
    })

    // If we are the only request, resolve the lock immediately, queue remains at 1 item until request ends.
    if (lockQueue.length === 1) {
      resolveNewLock()
    }

    await newLock
    return lockQueue
  }

  /**
   * Finishes an operation on a key and resolves the next waiting operation.
   *
   * @param {string} key - The key to finish the operation for.
   * @param {Array<(value: void | PromiseLike<void>) => void>} lockQueue - The lock queue from queueOperationOnKey.
   * @private
   */
  private finishOperationOnKey (key: string, lockQueue: Array<(value: void | PromiseLike<void>) => void>): void {
    lockQueue.shift() // Remove the current lock from the queue
    if (lockQueue.length > 0) {
      // If there are more locks waiting, resolve the next one
      lockQueue[0]()
    }
  }

  /**
   * Generates a protected key for the given key and context.
   *
   * @param {string} key - The original key to protect.
   * @param {PubKeyHex} controller - The public key of the controller.
   * @returns {Promise<string>} The base64-encoded protected key.
   * @throws {Error} If key derivation fails.
   * @private
   */
  private async getProtectedKey (key: string, controller: PubKeyHex): Promise<string> {
    const protectedKey = await new ProtoWallet('anyone').createHmac({
      protocolID: this.config.protocolID ?? DEFAULT_CONFIG.protocolID,
      keyID: key,
      counterparty: controller,
      data: Utils.toArray(key, 'utf8')
    })
    return Utils.toBase64(protectedKey.hmac)
  }

  /**
   * Helper function to fetch and cache user identity key
   *
   * @returns {Promise<PubKeyHex>} The identity key of the current user
   * @private
   */
  private async getIdentityKey (): Promise<PubKeyHex> {
    if (this.cachedIdentityKey == null) {
      this.cachedIdentityKey = (await this.wallet.getPublicKey({ identityKey: true }, this.config.originator)).publicKey
    }
    return this.cachedIdentityKey
  }

  /**
   * Looks up tokens from the overlay service.
   * Searches for existing key-value pairs using the protected key and decodes the stored values.
   *
   * @param {string} protectedKey - The protected key to search for.
   * @param {PubKeyHex | undefined} controller - The controller of the key
   * @param {boolean} [history=false] - Whether to include value history.
   * @returns {Promise<{token?: KVStoreToken, value?: string, valueHistory?: string[]}>} The found data or empty object.
   * @throws {Error} If the overlay service is unreachable or returns invalid data.
   * @private
   */
  private async findFromOverlay (protectedKey: string, controller: PubKeyHex, history = false): Promise<{ token?: KVStoreToken, value?: string, valueHistory?: string[] } | undefined> {
    const query: KVStoreQuery = {
      protectedKey,
      controller,
      history
    }

    const resolver = new LookupResolver({
      networkPreset: this.config.networkPreset
    })

    const answer = await resolver.query({
      service: 'ls_kvstore',
      query
    })

    // Check if we have results
    if (answer.type !== 'output-list' || answer.outputs.length === 0) {
      return {}
    }

    for (const result of answer.outputs) {
      try {
        // Verify signature
        const tx = Transaction.fromBEEF(result.beef)
        const output = tx.outputs[result.outputIndex]
        // Decode the KVStore token to extract the value
        const decoded = PushDrop.decode(output.lockingScript)
        if (decoded.fields.length !== 5) {
          throw new Error('Invalid KVStore token: expected 4 fields + sig')
        }

        // Verify key linkage
        const anyoneWallet = new ProtoWallet('anyone')
        const signature = decoded.fields.pop() as number[]
        const { valid } = await anyoneWallet.verifySignature({
          data: decoded.fields.reduce((a, e) => [...a, ...e], []),
          signature,
          counterparty: controller,
          protocolID: JSON.parse(Utils.toUTF8(decoded.fields[kvProtocol.namespace])),
          keyID: protectedKey
        })
        if (!valid) {
          continue
        }

        const currentValue: string = Utils.toUTF8(decoded.fields[kvProtocol.value]) // Default to plaintext

        if (history) {
          // Use Historian to extract complete history by traversing the input chain
          const valueHistory = await this.historian.buildHistory(tx, { protectedKey })
          return {
            token: {
              txid: tx.id('hex'),
              outputIndex: result.outputIndex,
              beef: Beef.fromBinary(result.beef),
              satoshis: output.satoshis ?? 0
            },
            value: currentValue,
            valueHistory
          }
        }

        return {
          token: {
            txid: tx.id('hex'),
            outputIndex: result.outputIndex,
            beef: Beef.fromBinary(result.beef),
            satoshis: output.satoshis ?? 0
          },
          value: currentValue
        }
      } catch (error) {
        continue
      }
    }
    // throw new Error('No valid tokens found')
    return undefined
  }

  /**
   * Submits a transaction to an overlay service using TopicBroadcaster.
   * Broadcasts the transaction to the configured topics for network propagation.
   *
   * @param {Transaction} transaction - The transaction to broadcast.
   * @returns {Promise<BroadcastResponse | BroadcastFailure>} The broadcast result.
   * @throws {Error} If the broadcast fails or the network is unreachable.
   * @private
   */
  private async submitToOverlay (transaction: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    const broadcaster = new TopicBroadcaster(this.config.topics ?? DEFAULT_CONFIG.topics, {
      networkPreset: this.config.networkPreset
    })
    return await broadcaster.broadcast(transaction)
  }

  /**
   * Retrieves the value associated with a given key from the global overlay network.
   * Uses atomic locking to ensure thread-safe operations.
   *
   * @param {string} key - The key to retrieve the value for.
   * @param {string | undefined} [defaultValue=undefined] - The value to return if the key is not found.
   * @param {PubKeyHex | 'self'} [controller='self'] - The controller of the key.
   * @param {boolean} [history=false] - Whether to include the complete value history.
   * @returns {Promise<string | undefined | { token: KVStoreToken, value: string, valueHistory?: string[] }>}
   *   A promise that resolves to the value as a string, the defaultValue if the key is not found,
   *   or a history object if history=true and the key exists.
   * @throws {Error} If the key is invalid or the overlay service is unreachable.
   * @throws {Error} If the found token's locking script cannot be decoded or represents an invalid token format.
   */
  async get (key: string, defaultValue?: string, controller?: PubKeyHex, history = false): Promise<string | undefined | { token: KVStoreToken, value: string, valueHistory?: string[] }> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('Key must be a non-empty string.')
    }

    const lockQueue = await this.queueOperationOnKey(key)

    try {
      if (controller == null || controller === 'self') {
        controller = await this.getIdentityKey()
      }
      const protectedKey = await this.getProtectedKey(key, controller)
      const results = await this.findFromOverlay(protectedKey, controller, history)

      if (results == null || results.token == null || results.value == null) {
        return defaultValue
      }

      // Return history object if requested and available
      if (history && results.valueHistory != null) {
        return {
          token: results.token,
          value: results.value,
          valueHistory: results.valueHistory
        }
      }

      return results.value
    } finally {
      this.finishOperationOnKey(key, lockQueue)
    }
  }

  /**
   * Convenience method for getting a value with history.
   * @param {string} key - The key to retrieve the value for.
   * @param {PubKeyHex | 'self'} [controller='self'] - The controller of the key.
   * @returns {Promise<string | undefined | { token: KVStoreToken, value: string, valueHistory?: string[] }>}
   * A promise that resolves to the value and history.
   */
  async getWithHistory (key: string, controller?: PubKeyHex): Promise<string | undefined | { token: KVStoreToken, value: string, valueHistory?: string[] }> {
    return await this.get(key, undefined, controller ?? 'self', true)
  }

  /**
   * Sets or updates the value associated with a given key atomically.
   * If the key already exists, it spends the existing token and creates a new one with the updated value.
   * If the key does not exist, it creates a new token.
   * Handles encryption if enabled and ensures atomicity by locking the key during the operation.
   *
   * @param {string} key - The key to set or update.
   * @param {string} value - The value to associate with the key.
   * @returns {Promise<OutpointString>} A promise that resolves to the outpoint string (txid.outputIndex) of the new or updated token.
   * @throws {Error} If the key or value is invalid.
   * @throws {Error} If the configuration is invalid (e.g., both send and receive from counterparty).
   * @throws {Error} If the overlay service is unreachable or the transaction fails.
   * @throws {Error} If there are existing tokens that cannot be unlocked.
   */
  async set (key: string, value: string): Promise<OutpointString> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('Key must be a non-empty string.')
    }
    if (typeof value !== 'string') {
      throw new Error('Value must be a string.')
    }

    const controller = await this.getIdentityKey()
    const lockQueue = await this.queueOperationOnKey(key)
    try {
      const protectedKey = await this.getProtectedKey(key, controller)
      const existingTokens = await this.findFromOverlay(protectedKey, controller)

      // Create PushDrop instance and locking script with the two required fields
      const pushdrop = new PushDrop(this.wallet, this.config.originator)
      const lockingScript = await pushdrop.lock(
        [
          Utils.toArray(JSON.stringify(this.config.protocolID ?? DEFAULT_CONFIG.protocolID), 'utf8'),
          Utils.toArray(protectedKey, 'base64'),
          Utils.toArray(value, 'utf8'),
          Utils.toArray(controller, 'hex')
        ],
        [1, 'kvstore'],
        protectedKey,
        'anyone',
        true
      )

      let inputs: CreateActionInput[] = []
      let inputBEEF: Beef | undefined

      if (existingTokens?.token != null) {
        // We have an existing token to spend
        inputs = [{
          outpoint: `${existingTokens.token.txid}.${existingTokens.token.outputIndex}`,
          unlockingScriptLength: 74,
          inputDescription: 'Previous KVStore token'
        }]
        inputBEEF = existingTokens.token.beef
      }
      if (inputs.length > 0) {
        // Update existing token - need to sign
        const { signableTransaction } = await this.wallet.createAction({
          description: `Update KVStore value for ${key}`,
          inputBEEF: inputBEEF?.toBinary(),
          inputs,
          outputs: [{
            satoshis: this.config.tokenAmount ?? 1,
            lockingScript: lockingScript.toHex(),
            outputDescription: 'KVStore token'
          }],
          options: {
            acceptDelayedBroadcast: this.config.acceptDelayedBroadcast,
            randomizeOutputs: false
          }
        }, this.config.originator)

        if (signableTransaction == null) {
          throw new Error('Unable to create update transaction')
        }

        // Sign the transaction
        const tx = Transaction.fromAtomicBEEF(signableTransaction.tx)
        const decoded = PushDrop.decode(lockingScript)
        const protocolID = JSON.parse(Utils.toUTF8(decoded.fields[kvProtocol.namespace]))
        const unlocker = pushdrop.unlock(
          protocolID,
          protectedKey,
          'anyone'
        )
        const unlockingScript = await unlocker.sign(tx, 0)

        const { tx: finalTx } = await this.wallet.signAction({
          reference: signableTransaction.reference,
          spends: { 0: { unlockingScript: unlockingScript.toHex() } }
        }, this.config.originator)

        if (finalTx == null) {
          throw new Error('Unable to finalize update transaction')
        }

        const transaction = Transaction.fromAtomicBEEF(finalTx)
        await this.submitToOverlay(transaction)
        return `${transaction.id('hex')}.0`
      } else {
        // New token - no inputs to sign
        const { tx } = await this.wallet.createAction({
          description: `Create KVStore value for ${key}`,
          outputs: [{
            satoshis: this.config.tokenAmount ?? 1,
            lockingScript: lockingScript.toHex(),
            outputDescription: 'KVStore token'
          }],
          options: {
            acceptDelayedBroadcast: this.config.acceptDelayedBroadcast,
            randomizeOutputs: false
          }
        }, this.config.originator)

        if (tx == null) {
          throw new Error('Failed to create transaction')
        }

        const transaction = Transaction.fromAtomicBEEF(tx)
        await this.submitToOverlay(transaction)
        return `${transaction.id('hex')}.0`
      }
    } finally {
      // Only finish operation if we haven't already done so in the retry logic
      if (lockQueue.length > 0) {
        this.finishOperationOnKey(key, lockQueue)
      }
    }
  }

  /**
   * Removes the key-value pair associated with the given key from the global overlay network.
   * It finds the existing token for the key and spends it without creating a new output.
   * Uses atomic locking to ensure thread-safe operations.
   *
   * @param {string} key - The key to remove.
   * @param {CreateActionOutput[] | undefined} [outputs=undefined] - Additional outputs to include in the removal transaction.
   * @returns {Promise<HexString>} A promise that resolves to the txid of the removal transaction if successful.
   * @throws {Error} If the key is invalid.
   * @throws {Error} If the key does not exist in the store.
   * @throws {Error} If the overlay service is unreachable or the transaction fails.
   * @throws {Error} If there are existing tokens that cannot be unlocked.
   */
  async remove (key: string, outputs?: CreateActionOutput[]): Promise<HexString> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('Key must be a non-empty string.')
    }
    const lockQueue = await this.queueOperationOnKey(key)
    try {
      const controller = await this.getIdentityKey()
      const protectedKey = await this.getProtectedKey(key, controller)
      const existingTokens = await this.findFromOverlay(protectedKey, controller)

      if (existingTokens?.token == null) {
        throw new Error('The item did not exist, no item was deleted.')
      }

      const kvstoreToken = existingTokens.token

      const inputs: CreateActionInput[] = [{
        outpoint: `${kvstoreToken.txid}.${kvstoreToken.outputIndex}`,
        unlockingScriptLength: 74,
        inputDescription: 'KVStore token to remove'
      }]

      const pushdrop = new PushDrop(this.wallet, this.config.originator)
      const { signableTransaction } = await this.wallet.createAction({
        description: `Remove KVStore value for ${key}`,
        inputBEEF: kvstoreToken.beef.toBinary(),
        inputs,
        outputs,
        options: {
          acceptDelayedBroadcast: this.config.acceptDelayedBroadcast
        }
      }, this.config.originator)

      if (signableTransaction == null) {
        throw new Error('Unable to create removal transaction')
      }

      // Sign the transaction
      const tx = Transaction.fromAtomicBEEF(signableTransaction.tx)
      const unlocker = pushdrop.unlock(
        this.config.protocolID ?? DEFAULT_CONFIG.protocolID,
        protectedKey,
        'anyone'
      )
      const unlockingScript = await unlocker.sign(tx, 0)

      const { tx: finalTx } = await this.wallet.signAction({
        reference: signableTransaction.reference,
        spends: { 0: { unlockingScript: unlockingScript.toHex() } }
      }, this.config.originator)

      if (finalTx == null) {
        throw new Error('Unable to finalize removal transaction')
      }

      const transaction = Transaction.fromAtomicBEEF(finalTx)
      await this.submitToOverlay(transaction)
      return transaction.id('hex')
    } finally {
      // Only finish operation if we haven't already done so in the retry logic
      if (lockQueue.length > 0) {
        this.finishOperationOnKey(key, lockQueue)
      }
    }
  }
}

export default GlobalKVStore
