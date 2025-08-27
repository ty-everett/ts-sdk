import Transaction from '../transaction/Transaction.js'
import * as Utils from '../primitives/utils.js'
import { Hash } from '../primitives/index.js'
import { TopicBroadcaster, LookupResolver } from '../overlay-tools/index.js'
import { BroadcastResponse, BroadcastFailure } from '../transaction/Broadcaster.js'
import { WalletInterface, CreateActionInput, WalletProtocol, OutpointString } from '../wallet/Wallet.interfaces.js'
import { PushDrop } from '../script/index.js'
import WalletClient from '../wallet/WalletClient.js'
import { Beef } from '../transaction/Beef.js'
import PubKeyHex from '../primitives/PublicKey.js'
import { Historian } from './Historian.js'
import { createKVStoreInterpreter } from './interpreters/createKVStoreInterpreter.js'

/**
 * Configuration interface for GlobalKVStore operations.
 * Defines all options for connecting to overlay services and managing KVStore behavior.
 */
export interface KVStoreConfig {
  /** The overlay service host URL */
  overlayHost?: string
  /** Protocol ID for the KVStore protocol */
  protocolID?: WalletProtocol
  /** Amount of satoshis for each token */
  tokenAmount?: number
  /** Topics for overlay submission */
  topics?: string[]
  /** Counterparty for key derivation */
  counterparty?: PubKeyHex | 'self'
  /** Whether receiving from counterparty */
  receiveFromCounterparty?: boolean
  /** Whether sending to counterparty */
  sendToCounterparty?: boolean
  /** Viewpoint for key derivation */
  viewpoint?: string | 'localToSelf'
  /** Whether to encrypt values before storing */
  encrypt?: boolean
  /** Maximum double spend retry attempts */
  doubleSpendMaxAttempts?: number
  /** Current attempt counter */
  attemptCounter?: number
  /** Originator identity */
  originator?: string
  /** Action description for transactions */
  actionDescription?: string
  /** Output description for transactions */
  outputDescription?: string
  /** Spending description for inputs */
  spendingDescription?: string
  /** Wallet interface for operations */
  wallet?: WalletInterface
  /** Network preset for overlay services */
  networkPreset?: 'mainnet' | 'testnet'
}

/**
 * Query parameters for KVStore lookups from overlay services.
 * Used when searching for existing key-value pairs in the network.
 */
export interface KVStoreQuery {
  protectedKey?: string
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
  history?: boolean
}

/**
 * Result structure for KVStore lookups from overlay services.
 * Contains the transaction output information for a found key-value pair.
 */
export interface KVStoreLookupResult {
  txid: string
  outputIndex: number
  outputScript: string
  satoshis: number
  history?: (output: any, currentDepth: number) => Promise<boolean>
}

/**
 * Token structure containing a KVStore token from overlay services.
 * Wraps the transaction data and metadata for a key-value pair.
 */
export interface KVStoreToken {
  txid: string
  outputIndex: number
  satoshis: number
  beef: Beef
}

/**
 * Default configuration values for GlobalKVStore operations.
 * Provides sensible defaults for overlay connection and protocol settings.
 */
const DEFAULT_CONFIG: Required<Omit<KVStoreConfig, 'wallet' | 'overlayHost' | 'originator'>> = {
  // overlayHost: 'https://backend.2b63ed8575c49054dd0ac65c61e7e6c6.projects.babbage.systems',
  protocolID: [1, 'kvstore'],
  tokenAmount: 1,
  topics: ['tm_kvstore'],
  counterparty: 'self',
  receiveFromCounterparty: false,
  sendToCounterparty: false,
  viewpoint: 'localToSelf',
  encrypt: true,
  doubleSpendMaxAttempts: 5,
  attemptCounter: 0,
  actionDescription: '',
  outputDescription: '',
  spendingDescription: '',
  networkPreset: 'mainnet'
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
   * A map to store locks for each key to ensure atomic updates.
   * @private
   */
  private readonly keyLocks: Map<string, Array<(value: void | PromiseLike<void>) => void>> = new Map()

  /**
   * Flag indicating whether to accept delayed broadcast for transactions.
   */
  acceptDelayedBroadcast: boolean = false

  /**
   * Creates an instance of the GlobalKVStore.
   *
   * @param {KVStoreConfig} [config={}] - Configuration options for the KVStore. Defaults to empty object.
   * @throws {Error} If the configuration contains invalid parameters.
   */
  constructor(config: KVStoreConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.wallet = config.wallet ?? new WalletClient()
    this.acceptDelayedBroadcast = false // Move to config?

    // Validate configuration
    if (this.config.sendToCounterparty === true && this.config.receiveFromCounterparty === true) {
      throw new Error('sendToCounterparty and receiveFromCounterparty cannot both be true at the same time.')
    }
  }

  /**
   * Queues an operation on a specific key to ensure atomic updates.
   * Prevents concurrent operations on the same key from interfering with each other.
   *
   * @param {string} key - The key to queue an operation for.
   * @returns {Promise<Array<(value: void | PromiseLike<void>) => void>>} The lock queue for cleanup.
   * @private
   */
  private async queueOperationOnKey(key: string): Promise<Array<(value: void | PromiseLike<void>) => void>> {
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
  private finishOperationOnKey(key: string, lockQueue: Array<(value: void | PromiseLike<void>) => void>): void {
    lockQueue.shift() // Remove the current lock from the queue
    if (lockQueue.length > 0) {
      // If there are more locks waiting, resolve the next one
      lockQueue[0]()
    }
  }

  /**
   * Computes an invoice number for key derivation.
   * Used in viewpoint-based key protection when not using localToSelf viewpoint.
   *
   * @param {[number, string] | string} protocolID - The protocol identifier.
   * @param {string} key - The key to compute invoice number for.
   * @returns {string} The computed invoice number.
   * @private
   */
  private computeInvoiceNumber(protocolID: [number, string] | string, key: string): string {
    if (typeof protocolID === 'string') {
      return `2-${protocolID}-${key}`
    }
    return `${protocolID[0]}-${protocolID[1]}-${key}`
  }

  /**
   * Generates a protected key for the given key and context.
   * Uses createHMAC to derive a protected key based on the viewpoint and counterparty settings.
   *
   * @param {string} key - The original key to protect.
   * @param {'searching' | 'creating'} [context='searching'] - The context for key generation (searching existing or creating new).
   * @returns {Promise<string>} The base64-encoded protected key.
   * @throws {Error} If key derivation fails.
   * @private
   */
  private async getProtectedKey(key: string, context: 'searching' | 'creating' = 'searching'): Promise<string> {
    if (this.config.viewpoint === 'localToSelf') {
      let counterparty = this.config.counterparty

      // Counterparty should flip to self when:
      // - context is searching and sendToCounterparty is true
      // - context is creating and receiveFromCounterparty is true
      if (
        (context === 'searching' && this.config.sendToCounterparty === true) ||
        (context === 'creating' && this.config.receiveFromCounterparty === true)
      ) {
        counterparty = 'self'
      }

      // Use wallet for HMAC computation
      const invoiceNumber = this.computeInvoiceNumber(this.config.protocolID, key)
      const protectedKey = await this.wallet.createHmac({
        protocolID: this.config.protocolID,
        keyID: invoiceNumber,
        counterparty: counterparty === 'self' ? 'self' : counterparty.toString(),
        data: Utils.toArray('', 'utf8')
      }, this.config.originator)
      return Utils.toBase64(protectedKey.hmac)
    } else {
      // TODO: Review this logic
      const invoiceNumber = this.computeInvoiceNumber(this.config.protocolID, key)
      const viewpointBytes = Utils.toArray(this.config.viewpoint, 'hex')
      const hmacKey = Hash.sha256(viewpointBytes)
      const hmacData = Utils.toArray(invoiceNumber, 'utf8')
      const hmac = Hash.sha256hmac(hmacKey, hmacData)
      return Utils.toBase64(hmac)
    }
  }

  /**
   * Looks up tokens from the overlay service.
   * Searches for existing key-value pairs using the protected key and decodes the stored values.
   *
   * @param {string} protectedKey - The protected key to search for.
   * @param {string} key - The original key for decryption.
   * @param {boolean} [history=false] - Whether to include value history.
   * @returns {Promise<{token?: KVStoreToken, value?: string, valueHistory?: string[]}>} The found data or empty object.
   * @throws {Error} If the overlay service is unreachable or returns invalid data.
   * @private
   */
  private async findFromOverlay(protectedKey: string, key: string, history = false): Promise<{ token?: KVStoreToken, value?: string, valueHistory?: string[] }> {
    const query: KVStoreQuery = {
      protectedKey,
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

    // Get the first result (most recent)
    const result = answer.outputs[0]
    const tx = Transaction.fromBEEF(result.beef)
    const output = tx.outputs[result.outputIndex]

    // Decode the KVStore token to extract the value
    const decoded = PushDrop.decode(output.lockingScript)
    if (decoded.fields.length !== 3) {
      throw new Error('Invalid KVStore token: expected 2 fields + sig')
    }

    let currentValue: string = Utils.toUTF8(decoded.fields[1]) // Default to plaintext

    if (this.config.encrypt === true) {
      // Try to decrypt the value using wallet
      try {
        const { plaintext } = await this.wallet.decrypt({
          protocolID: this.config.protocolID,
          keyID: key,
          ciphertext: decoded.fields[1]
        })
        currentValue = Utils.toUTF8(plaintext)
      } catch {
        // Decryption failed, using plaintext fallback
      }
    }

    if (history) {
      // Use Historian to extract complete history by traversing the input chain
      const interpreter = createKVStoreInterpreter({
        protectedKey,
        key,
        encrypt: this.config.encrypt,
        wallet: this.wallet,
        protocolID: this.config.protocolID
      })

      const historian = new Historian<string>(interpreter, { debug: false })
      const valueHistory = await historian.buildHistory(tx)

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
  private async submitToOverlay(transaction: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    const broadcaster = new TopicBroadcaster(['tm_kvstore'], {
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
   * @param {boolean} [history=false] - Whether to include the complete value history.
   * @returns {Promise<string | undefined | { token: KVStoreToken, value: string, valueHistory?: string[] }>}
   *   A promise that resolves to the value as a string, the defaultValue if the key is not found,
   *   or a history object if history=true and the key exists.
   * @throws {Error} If the key is invalid or the overlay service is unreachable.
   * @throws {Error} If the found token's locking script cannot be decoded or represents an invalid token format.
   */
  async get(key: string, defaultValue?: string, history = false): Promise<string | undefined | { token: KVStoreToken, value: string, valueHistory?: string[] }> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('Key must be a non-empty string.')
    }

    const lockQueue = await this.queueOperationOnKey(key)

    try {
      const protectedKey = await this.getProtectedKey(key, 'searching')
      const results = await this.findFromOverlay(protectedKey, key, history)

      if (results.token == null || results.value == null) {
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
   * Retrieves the value associated with a given key along with its complete history.
   * This is a convenience method equivalent to calling get(key, defaultValue, true).
   *
   * @param {string} key - The key to retrieve the value and history for.
   * @param {string | undefined} [defaultValue=undefined] - The value to return if the key is not found.
   * @returns {Promise<{ token: KVStoreToken, value: string, valueHistory: string[] } | undefined>}
   *   A promise that resolves to a history object with the current value and all previous values,
   *   or undefined if the key is not found.
   * @throws {Error} If the key is invalid or the overlay service is unreachable.
   */
  async getWithHistory(key: string, defaultValue?: string): Promise<{ token: KVStoreToken, value: string, valueHistory: string[] } | undefined> {
    const result = await this.get(key, defaultValue, true)

    // Return undefined if no result, otherwise return the history object
    if (typeof result === 'object' && result.valueHistory != null) {
      return result as { token: KVStoreToken, value: string, valueHistory: string[] }
    }

    return undefined
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
  async set(key: string, value: string): Promise<OutpointString> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('Key must be a non-empty string.')
    }

    if (typeof value !== 'string') {
      throw new Error('Value must be a string.')
    }

    const lockQueue = await this.queueOperationOnKey(key)

    try {
      const protectedKey = await this.getProtectedKey(key, 'searching')
      const existingTokens = await this.findFromOverlay(protectedKey, key)

      const protocol = {
        protocolID: this.config.protocolID,
        keyID: key
      }

      // Prepare the value field
      const newProtectedKey = await this.getProtectedKey(key, 'creating')
      let valueAsArray = Utils.toArray(value, 'utf8')

      // Encrypt the value if encryption is enabled
      if (this.config.encrypt === true) {
        const { ciphertext } = await this.wallet.encrypt({
          ...protocol,
          plaintext: valueAsArray
        })
        valueAsArray = ciphertext
      }

      // The protected key must be exactly 32 bytes as expected by topic manager
      const protectedKeyBytes = Utils.toArray(newProtectedKey, 'base64')
      if (protectedKeyBytes.length !== 32) {
        throw new Error(`Protected key must be exactly 32 bytes, got ${protectedKeyBytes.length} bytes`)
      }

      // Create PushDrop instance and locking script with the two required fields
      const pushdrop = new PushDrop(this.wallet, this.config.originator)
      const lockingScript = await pushdrop.lock(
        [protectedKeyBytes, valueAsArray],
        protocol.protocolID,
        key,
        'self'
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
      } else if (this.config.receiveFromCounterparty === true) {
        throw new Error('There is no token to receive from this counterparty')
      }

      try {
        if (inputs.length > 0) {
          // Update existing token - need to sign
          const { signableTransaction } = await this.wallet.createAction({
            description: `Update KVStore value for ${key}`,
            inputBEEF: inputBEEF?.toBinary(),
            inputs,
            outputs: [{
              satoshis: this.config.tokenAmount,
              lockingScript: lockingScript.toHex(),
              outputDescription: 'KVStore token'
            }],
            options: {
              acceptDelayedBroadcast: this.acceptDelayedBroadcast,
              randomizeOutputs: false
            }
          })

          if (signableTransaction == null) {
            throw new Error('Unable to create update transaction')
          }

          // Sign the transaction
          const tx = Transaction.fromAtomicBEEF(signableTransaction.tx)
          const unlocker = pushdrop.unlock(
            this.config.protocolID,
            key,
            'self'
          )
          const unlockingScript = await unlocker.sign(tx, 0)

          const { tx: finalTx } = await this.wallet.signAction({
            reference: signableTransaction.reference,
            spends: { 0: { unlockingScript: unlockingScript.toHex() } }
          })

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
              satoshis: this.config.tokenAmount,
              lockingScript: lockingScript.toHex(),
              outputDescription: 'KVStore token'
            }],
            options: {
              acceptDelayedBroadcast: this.acceptDelayedBroadcast,
              randomizeOutputs: false
            }
          })

          if (tx == null) {
            throw new Error('Failed to create transaction')
          }

          const transaction = Transaction.fromAtomicBEEF(tx)
          await this.submitToOverlay(transaction)

          return `${transaction.id('hex')}.0`
        }
      } catch (error: any) {
        // TODO: Handle double spend attempts
        // if (error.code === 'ERR_DOUBLE_SPEND' && this.config.attemptCounter! < this.config.doubleSpendMaxAttempts!) {
        //   this.config.attemptCounter!++
        //   // Release current lock and retry with a fresh lock
        //   this.finishOperationOnKey(key, lockQueue)
        //   return this.set(key, value)
        // }
        throw new Error('Failed to set key-value pair')
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
   * @returns {Promise<string[]>} A promise that resolves to the txids of the removal transactions if successful.
   * @throws {Error} If the key is invalid.
   * @throws {Error} If the key does not exist in the store.
   * @throws {Error} If the overlay service is unreachable or the transaction fails.
   * @throws {Error} If there are existing tokens that cannot be unlocked.
   */
  async remove(key: string): Promise<string[]> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('Key must be a non-empty string.')
    }

    const lockQueue = await this.queueOperationOnKey(key)

    try {
      const protectedKey = await this.getProtectedKey(key, 'searching')
      const existingTokens = await this.findFromOverlay(protectedKey, key)

      if (existingTokens?.token == null) {
        throw new Error('The item did not exist, no item was deleted.')
      }

      const kvstoreToken = existingTokens.token

      const inputs: CreateActionInput[] = [{
        outpoint: `${kvstoreToken.txid}.${kvstoreToken.outputIndex}`,
        unlockingScriptLength: 74,
        inputDescription: 'KVStore token to remove'
      }]

      try {
        const pushdrop = new PushDrop(this.wallet, this.config.originator)
        const { signableTransaction } = await this.wallet.createAction({
          description: `Remove KVStore value for ${key}`,
          inputBEEF: kvstoreToken.beef.toBinary(),
          inputs,
          options: {
            acceptDelayedBroadcast: this.acceptDelayedBroadcast
          }
        })

        if (signableTransaction == null) {
          throw new Error('Unable to create removal transaction')
        }

        // Sign the transaction
        const tx = Transaction.fromAtomicBEEF(signableTransaction.tx)
        const unlocker = pushdrop.unlock(
          this.config.protocolID,
          key,
          'self'
        )
        const unlockingScript = await unlocker.sign(tx, 0)

        const { tx: finalTx } = await this.wallet.signAction({
          reference: signableTransaction.reference,
          spends: { 0: { unlockingScript: unlockingScript.toHex() } }
        })

        if (finalTx == null) {
          throw new Error('Unable to finalize removal transaction')
        }

        const transaction = Transaction.fromAtomicBEEF(finalTx)
        await this.submitToOverlay(transaction)

        return [transaction.id('hex')]
      } catch (error: any) {
        // TODO: Handle double spend attempts
        // if (error.code === 'ERR_DOUBLE_SPEND' && this.config.attemptCounter! < this.config.doubleSpendMaxAttempts!) {
        //   this.config.attemptCounter!++
        //   // Release current lock and retry with a fresh lock
        //   this.finishOperationOnKey(key, lockQueue)
        //   return this.remove(key)
        // }
        throw new Error(`There is 1 output with key ${key} that cannot be unlocked.`)
      }
    } finally {
      // Only finish operation if we haven't already done so in the retry logic
      if (lockQueue.length > 0) {
        this.finishOperationOnKey(key, lockQueue)
      }
    }
  }
}

export default GlobalKVStore
