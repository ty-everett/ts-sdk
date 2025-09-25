import { PushDrop } from '../../script/index.js'
import Transaction from '../../transaction/Transaction.js'
import * as Utils from '../../primitives/utils.js'
import { kvProtocol } from './types.js'

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
 * Creates a KVStore-specific interpreter for use with Historian.
 * Handles KVStore token format validation, protected key filtering, 
 * and decryption.
 * 
 * @param protectedKey - Protected key to filter tokens by
 * @returns TokenInterpreter function for KVStore tokens
 */
export const createKVStoreInterpreter = (protectedKey: string): TokenInterpreter<string> => {
  return async (transaction: Transaction, outputIndex: number): Promise<string | undefined> => {
    try {
      const output = transaction.outputs[outputIndex]
      if (!output?.lockingScript) return undefined

      // Decode the KVStore token
      const decoded = PushDrop.decode(output.lockingScript)

      // Validate KVStore token format (must have 5 fields: [protocolID, protectedKey, value, controller, signature])
      if (decoded.fields.length !== Object.keys(kvProtocol).length) return undefined

      // Validate that first field is a 32-byte protected key
      if (decoded.fields[kvProtocol.protectedKey].length !== 32) return undefined

      // Filter by protected key - only return values for this specific key
      const pKey = Utils.toBase64(decoded.fields[kvProtocol.protectedKey])
      if (pKey !== protectedKey) return undefined
      try {
        return Utils.toUTF8(decoded.fields[kvProtocol.value])
      } catch {
        return undefined
      }
    } catch {
      // Skip non-KVStore outputs or malformed tokens
      return undefined
    }
  }
}