import Transaction from '../../transaction/Transaction.js'
import { Beef } from '../../transaction/Beef.js'

/**
 * Token interpreter function interface.
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
 * Result from KVStore operations with BEEF data
 */
export interface KVStoreResult {
  value?: string
  beef?: Beef
  history?: string[]
}
