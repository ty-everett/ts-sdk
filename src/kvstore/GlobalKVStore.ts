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
import { kvProtocol, KVStoreConfig, KVStoreQuery, GetParams, KVStoreEntry } from './types.js'

/**
 * Default configuration values for GlobalKVStore operations.
 * Provides sensible defaults for overlay connection and protocol settings.
 */
const DEFAULT_CONFIG: Required<Omit<KVStoreConfig, 'wallet' | 'originator'>> = {
  overlayHost: 'http://localhost:8080',
  protocolID: [1, 'kvstore'],
  tokenAmount: 1,
  topics: ['tm_kvstore'],
  networkPreset: 'local',
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
   * Lookup resolver used to query the overlay for transaction outputs.
   * @private
   */
  private readonly lookupResolver: LookupResolver

  /**
   * Topic broadcaster used to broadcast transactions to the overlay.
   * @private
   */
  private readonly topicBroadcaster: TopicBroadcaster

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
   * @param {WalletInterface} [config.wallet] - Wallet to use for operations. Defaults to WalletClient.
   * @throws {Error} If the configuration contains invalid parameters.
   */
  constructor(config: KVStoreConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.wallet = config.wallet ?? new WalletClient()
    this.historian = new Historian<string, KVContext>(kvStoreInterpreter)
    this.lookupResolver = new LookupResolver({
      networkPreset: this.config.networkPreset
    })
    this.topicBroadcaster = new TopicBroadcaster(this.config.topics ?? DEFAULT_CONFIG.topics, {
      networkPreset: this.config.networkPreset
    })
  }

  /**
   * Retrieves data from the KVStore.
   * Can query by specific key+controller or by namespace.
   *
   * @param {GetParams} params - Query parameters
   * @param {boolean} [includeToken=false] - Whether to include the token transaction data in the results
   * @returns {Promise<KVStoreEntry | KVStoreEntry[] | undefined>} Single entry for key queries, array for namespace queries
   */
  async get(params: GetParams, includeToken: boolean = false): Promise<KVStoreEntry | KVStoreEntry[] | undefined> {
    if (params.namespace) {
      // Namespace query - return all entries under the namespace
      return await this.queryOverlay(params, includeToken)
    } else if (params.key) {
      // Specific key query - return single entry
      const entries = await this.queryOverlay(params, includeToken)
      return entries.length > 0 ? entries[0] : undefined
    } else {
      throw new Error('Must specify either key or namespace')
    }
  }

  /**
   * Sets a key-value pair. The current user (wallet identity) becomes the controller.
   *
   * @param {string} key - The key to set (user computes this however they want)
   * @param {string} value - The value to store
   * @returns {Promise<OutpointString>} The outpoint of the created token
   */
  async set(key: string, value: string): Promise<OutpointString> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('Key must be a non-empty string.')
    }
    if (typeof value !== 'string') {
      throw new Error('Value must be a string.')
    }

    const controller = await this.getIdentityKey()
    const lockQueue = await this.queueOperationOnKey(key)

    try {
      // Check for existing token to spend
      const existingEntries = await this.queryOverlay({ key, controller })
      const existingToken = existingEntries.length > 0 ? existingEntries[0].token : undefined

      // Create PushDrop locking script
      const pushdrop = new PushDrop(this.wallet, this.config.originator)
      const lockingScript = await pushdrop.lock(
        [
          Utils.toArray(JSON.stringify(this.config.protocolID ?? DEFAULT_CONFIG.protocolID), 'utf8'),
          Utils.toArray(key, 'utf8'),
          Utils.toArray(value, 'utf8'),
          Utils.toArray(controller, 'hex')
        ],
        [1, 'kvstore'],
        Utils.toUTF8(Utils.toArray(key, 'utf8')),
        'anyone',
        true
      )

      let inputs: CreateActionInput[] = []
      let inputBEEF: Beef | undefined

      if (existingToken != null) {
        inputs = [{
          outpoint: `${existingToken.txid}.${existingToken.outputIndex}`,
          unlockingScriptLength: 74,
          inputDescription: 'Previous KVStore token'
        }]
        inputBEEF = existingToken.beef
      }

      if (inputs.length > 0) {
        // Update existing token
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

        const tx = Transaction.fromAtomicBEEF(signableTransaction.tx)
        const unlocker = pushdrop.unlock(
          this.config.protocolID ?? DEFAULT_CONFIG.protocolID,
          key,
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
        // Create new token
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
      if (lockQueue.length > 0) {
        this.finishOperationOnKey(key, lockQueue)
      }
    }
  }

  /**
   * Removes the key-value pair associated with the given key from the overlay service.
   *
   * @param {string} key - The key to remove.
   * @param {CreateActionOutput[] | undefined} [outputs=undefined] - Additional outputs to include in the removal transaction.
   * @returns {Promise<HexString>} A promise that resolves to the txid of the removal transaction if successful.
   * @throws {Error} If the key is invalid.
   * @throws {Error} If the key does not exist in the store.
   * @throws {Error} If the overlay service is unreachable or the transaction fails.
   * @throws {Error} If there are existing tokens that cannot be unlocked.
   */
  async remove(key: string, outputs?: CreateActionOutput[]): Promise<HexString> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('Key must be a non-empty string.')
    }

    const controller = await this.getIdentityKey()
    const lockQueue = await this.queueOperationOnKey(key)

    try {
      const existingEntries = await this.queryOverlay({ key, controller })

      if (existingEntries.length === 0) {
        throw new Error('The item did not exist, no item was deleted.')
      }

      const existingToken = existingEntries[0].token
      const inputs: CreateActionInput[] = [{
        outpoint: `${existingToken.txid}.${existingToken.outputIndex}`,
        unlockingScriptLength: 74,
        inputDescription: 'KVStore token to remove'
      }]

      const pushdrop = new PushDrop(this.wallet, this.config.originator)
      const { signableTransaction } = await this.wallet.createAction({
        description: `Remove KVStore value for ${key}`,
        inputBEEF: existingToken.beef.toBinary(),
        inputs,
        outputs,
        options: {
          acceptDelayedBroadcast: this.config.acceptDelayedBroadcast
        }
      }, this.config.originator)

      if (signableTransaction == null) {
        throw new Error('Unable to create removal transaction')
      }

      const tx = Transaction.fromAtomicBEEF(signableTransaction.tx)
      const unlocker = pushdrop.unlock(
        this.config.protocolID ?? DEFAULT_CONFIG.protocolID,
        key,
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
      if (lockQueue.length > 0) {
        this.finishOperationOnKey(key, lockQueue)
      }
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
   * Helper function to fetch and cache user identity key
   *
   * @returns {Promise<PubKeyHex>} The identity key of the current user
   * @private
   */
  private async getIdentityKey(): Promise<PubKeyHex> {
    if (this.cachedIdentityKey == null) {
      this.cachedIdentityKey = (await this.wallet.getPublicKey({ identityKey: true }, this.config.originator)).publicKey
    }
    return this.cachedIdentityKey
  }

  /**
   * Queries the overlay service for KV entries.
   *
   * @param {GetParams} params - Query parameters
   * @returns {Promise<KVStoreEntry[]>} Array of matching KV entries
   * @private
   */
  private async queryOverlay(params: GetParams, includeToken: boolean = false): Promise<KVStoreEntry[]> {
    const query: KVStoreQuery = {
      key: params.key,
      controller: params.controller,
      namespace: params.namespace,
      history: params.history
    }

    const answer = await this.lookupResolver.query({
      service: 'ls_kvstore',
      query
    })

    if (answer.type !== 'output-list' || answer.outputs.length === 0) {
      return []
    }

    const entries: KVStoreEntry[] = []

    for (const result of answer.outputs) {
      try {
        const tx = Transaction.fromBEEF(result.beef)
        const output = tx.outputs[result.outputIndex]
        const decoded = PushDrop.decode(output.lockingScript)

        if (decoded.fields.length !== 5) {
          continue
        }

        // Verify signature
        const anyoneWallet = new ProtoWallet('anyone')
        const signature = decoded.fields.pop() as number[]
        const { valid } = await anyoneWallet.verifySignature({
          data: decoded.fields.reduce((a, e) => [...a, ...e], []),
          signature,
          counterparty: Utils.toHex(decoded.fields[kvProtocol.controller]),
          protocolID: JSON.parse(Utils.toUTF8(decoded.fields[kvProtocol.namespace])),
          keyID: Utils.toUTF8(decoded.fields[kvProtocol.key])
        })

        if (!valid) {
          continue
        }

        const entry: KVStoreEntry = {
          key: Utils.toUTF8(decoded.fields[kvProtocol.key]),
          value: Utils.toUTF8(decoded.fields[kvProtocol.value]),
          controller: Utils.toHex(decoded.fields[kvProtocol.controller])
        }

        if (includeToken) {
          entry.token = {
            txid: tx.id('hex'),
            outputIndex: result.outputIndex,
            beef: Beef.fromBinary(result.beef),
            satoshis: output.satoshis ?? 0
          }
        }

        if (params.history) {
          entry.history = await this.historian.buildHistory(tx, { key: entry.key })
        }

        entries.push(entry)
      } catch (error) {
        continue
      }
    }

    return entries
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
    return await this.topicBroadcaster.broadcast(transaction)
  }
}

export default GlobalKVStore
