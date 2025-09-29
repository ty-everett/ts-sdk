import { PushDrop } from '../script/index.js'
import Transaction from '../transaction/Transaction.js'
import * as Utils from '../primitives/utils.js'
import { kvProtocol } from './types.js'
import { InterpreterFunction } from '../overlay-tools/Historian.js'

export interface KVContext { protectedKey: string }

/**
 * KVStore interpreter used by Historian.
 *
 * Validates the KVStore PushDrop tokens: [namespace, protectedKey, value, controller, signature].
 * Filters outputs by the provided protected key in the interpreter context.
 * Produces the plaintext value for matching outputs; returns undefined otherwise.
 *
 * @param transaction - The transaction to inspect.
 * @param outputIndex - The index of the output within transaction.outputs.
 * @param ctx - { protectedKey: string } — per-call context specifying which protected key to match.
 *
 * @returns string | undefined — the decoded KV value if the output is a valid KVStore token for the
 *   given protected key; otherwise undefined.
 */
export const kvStoreInterpreter: InterpreterFunction<string, KVContext> = async (transaction: Transaction, outputIndex: number, ctx?: KVContext): Promise<string | undefined> => {
  try {
    const output = transaction.outputs[outputIndex]
    if (output == null || output.lockingScript == null) return undefined
    if (ctx == null || ctx.protectedKey == null) return undefined

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
