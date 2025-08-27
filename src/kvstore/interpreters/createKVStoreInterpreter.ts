import { PushDrop } from '../../script/index.js'
import Transaction from '../../transaction/Transaction.js'
import * as Utils from '../../primitives/utils.js'
import { WalletInterface, WalletProtocol } from '../../wallet/Wallet.interfaces.js'

/**
 * Token interpreter function interface for KVStore tokens.
 * Extracts and validates token data from transaction outputs.
 */
export interface TokenInterpreter<T = string> {
  /**
   * Interprets token data from a transaction output
   * @param transaction - The transaction containing the token output
   * @param outputIndex - The index of the output to decode
   * @returns The decoded token value or undefined if invalid
   */
  (transaction: Transaction, outputIndex: number): T | undefined | Promise<T | undefined>
}

/**
 * Configuration for KVStore interpreter
 */
export interface KVStoreInterpreterConfig {
  /** Protected key to filter tokens by */
  protectedKey: string
  /** Original key for decryption */
  key: string
  /** Whether encryption is enabled */
  encrypt?: boolean
  /** Wallet interface for decryption */
  wallet?: WalletInterface
  /** Protocol ID for decryption */
  protocolID?: WalletProtocol
}

/**
 * Creates a KVStore-specific interpreter for use with Historian.
 * Handles KVStore token format validation, protected key filtering, 
 * and encryption/decryption.
 * 
 * @param config - Configuration for the interpreter
 * @returns TokenInterpreter function for KVStore tokens
 */
export const createKVStoreInterpreter = (config: KVStoreInterpreterConfig): TokenInterpreter<string> => {
  return async (transaction: Transaction, outputIndex: number): Promise<string | undefined> => {
    try {
      const output = transaction.outputs[outputIndex]
      if (!output?.lockingScript) return undefined

      // Decode the KVStore token
      const decoded = PushDrop.decode(output.lockingScript)
      
      // Validate KVStore token format (must have at least 2 fields: [protectedKey, value])
      if (decoded.fields.length < 2) return undefined
      
      // Validate that first field is a 32-byte protected key
      if (decoded.fields[0].length !== 32) return undefined
      
      // Filter by protected key - only return values for this specific key
      const keyFromOutput = Utils.toBase64(decoded.fields[0])
      if (keyFromOutput !== config.protectedKey) return undefined

      // Handle encryption/decryption
      if (config.encrypt === true && config.wallet && config.protocolID) {
        try {
          const { plaintext } = await config.wallet.decrypt({
            protocolID: config.protocolID,
            keyID: config.key,
            ciphertext: decoded.fields[1]
          })
          return Utils.toUTF8(plaintext)
        } catch {
          // Decryption failed, fall back to plaintext (backward compatibility)
          try {
            return Utils.toUTF8(decoded.fields[1])
          } catch {
            // Skip values that can't be processed as either encrypted or plaintext
            return undefined
          }
        }
      } else {
        // No encryption, treat as plaintext
        try {
          return Utils.toUTF8(decoded.fields[1])
        } catch {
          return undefined
        }
      }
    } catch {
      // Skip non-KVStore outputs or malformed tokens
      return undefined
    }
  }
}