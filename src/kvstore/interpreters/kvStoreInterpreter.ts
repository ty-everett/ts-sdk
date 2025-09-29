import { PushDrop } from '../../script/index.js'
import Transaction from '../../transaction/Transaction.js'
import * as Utils from '../../primitives/utils.js'
import { kvProtocol } from './types.js'
import { InterpreterFunction } from '../../overlay-tools/Historian.js'

export type KVContext = { protectedKey: string }

/**
 * KVStore-specific interpreter for use with Historian.
 * Handles KVStore token format validation, and protected key filtering.
 * 
 * @param protectedKey - Protected key to filter tokens by
 * @returns TokenInterpreter function for KVStore tokens
 */
export const kvStoreInterpreter: InterpreterFunction<string, KVContext> = async (transaction: Transaction, outputIndex: number, ctx?: KVContext): Promise<string | undefined> => {
  try {
    const output = transaction.outputs[outputIndex]
    if (!output?.lockingScript) return undefined
    if (!ctx?.protectedKey) return undefined

    // Decode the KVStore token
    const decoded = PushDrop.decode(output.lockingScript)

    // Validate KVStore token format (must have 5 fields: [protocolID, protectedKey, value, controller, signature])
    if (decoded.fields.length !== Object.keys(kvProtocol).length) return undefined

    // Validate protectedKey field length (32 bytes)
    if (decoded.fields[kvProtocol.protectedKey].length !== 32) return undefined

    // Filter by protected key - only return values for this specific key
    const pKey = Utils.toBase64(decoded.fields[kvProtocol.protectedKey])
    if (pKey !== ctx.protectedKey) return undefined
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