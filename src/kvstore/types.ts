import { Beef } from '../transaction/Beef.js'
import { PubKeyHex, WalletProtocol } from '../wallet/Wallet.interfaces.js'
import { WalletInterface } from '../wallet/index.js'

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
  /** Originator */
  originator?: string
  /** Wallet interface for operations */
  wallet?: WalletInterface
  /** Network preset for overlay services */
  networkPreset?: 'mainnet' | 'testnet' | 'local'
  /** Whether to accept delayed broadcast */
  acceptDelayedBroadcast?: boolean
}

/**
 * Query parameters for KVStore lookups from overlay services.
 * Used when searching for existing key-value pairs in the network.
 */
export interface KVStoreQuery {
  protectedKey?: string
  controller?: PubKeyHex
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

export const kvProtocol = {
  namespace: 0,
  protectedKey: 1,
  value: 2,
  controller: 3,
  signature: 4
}
