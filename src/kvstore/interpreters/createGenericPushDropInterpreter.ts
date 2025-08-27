import { PushDrop } from '../../script/index.js'
import Transaction from '../../transaction/Transaction.js'
import * as Utils from '../../primitives/utils.js'
import type { TokenInterpreter } from './types.js'

/**
 * Creates a generic PushDrop interpreter without key validation.
 * Attempts to decode any PushDrop token and returns the first field as UTF-8.
 * Used as a fallback when no specific interpreter is provided.
 * 
 * @returns TokenInterpreter function for generic PushDrop tokens
 */
export const createGenericPushDropInterpreter = (): TokenInterpreter<string> => {
  return (transaction: Transaction, outputIndex: number): string | undefined => {
    try {
      const output = transaction.outputs[outputIndex]
      if (!output?.lockingScript) return undefined

      const decoded = PushDrop.decode(output.lockingScript)

      // Return first field as UTF-8, no key validation
      return decoded.fields.length > 0 ? Utils.toUTF8(decoded.fields[0]) : undefined
    } catch {
      return undefined
    }
  }
}
