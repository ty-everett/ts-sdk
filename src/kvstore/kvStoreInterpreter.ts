import { PushDrop } from '../script/index.js'
import Transaction from '../transaction/Transaction.js'
import * as Utils from '../primitives/utils.js'
import { kvProtocol } from './types.js'
import { InterpreterFunction } from '../overlay-tools/Historian.js'

export interface KVContext { key: string }

/**
 * KVStore interpreter used by Historian.
 *
 * Validates the KVStore PushDrop tokens: [protocolID, key, value, controller, signature].
 * Filters outputs by the provided key in the interpreter context.
 * Produces the plaintext value for matching outputs; returns undefined otherwise.
 *
 * @param transaction - The transaction to inspect.
 * @param outputIndex - The index of the output within transaction.outputs.
 * @param ctx - { key: string } — per-call context specifying which key to match.
 *
 * @returns string | undefined — the decoded KV value if the output is a valid KVStore token for the
 *   given key; otherwise undefined.
 */
export const kvStoreInterpreter: InterpreterFunction<string, KVContext> = async (transaction: Transaction, outputIndex: number, ctx?: KVContext): Promise<string | undefined> => {
  try {
    const output = transaction.outputs[outputIndex]
    if (output == null || output.lockingScript == null) return undefined
    if (ctx == null || ctx.key == null) return undefined

    // Decode the KVStore token
    const decoded = PushDrop.decode(output.lockingScript)

    // Validate KVStore token format (must have 5 fields: [protocolID, key, value, controller, signature])
    if (decoded.fields.length !== Object.keys(kvProtocol).length) return undefined

    // Filter by key - only return values for this specific key
    const pKey = Utils.toUTF8(decoded.fields[kvProtocol.key])
    if (pKey !== ctx.key) return undefined
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
