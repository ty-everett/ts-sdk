import { InterpreterFunction, HistoryFilter } from '../Historian.js'
import Transaction from '../../transaction/Transaction.js'
import { PushDrop } from '../../script/index.js'
import * as Utils from '../../primitives/utils.js'
import { WalletInterface, WalletProtocol } from '../../wallet/Wallet.interfaces.js'

/**
 * Configuration for KVStore interpreter function
 */
export interface KVStoreInterpreterConfig {
  wallet: WalletInterface
  protocolID: WalletProtocol
  keyID: string
  encrypt?: boolean
}

/**
 * Creates a KVStore-style interpreter function that extracts encrypted or plaintext values
 */
export function createKVStoreInterpreterFunction(config: KVStoreInterpreterConfig): InterpreterFunction<string> {
  return async (transaction: Transaction, outputIndex: number): Promise<string | undefined> => {
    try {
      const output = transaction.outputs[outputIndex]
      if (!output) return undefined

      const decoded = PushDrop.decode(output.lockingScript)

      // KVStore format: [protectedKey(32 bytes), value, signature]
      if (decoded.fields.length !== 3 || decoded.fields[0].length !== 32) {
        return undefined
      }

      let value: string
      if (config.encrypt) {
        try {
          // Try decryption first
          const { plaintext } = await config.wallet.decrypt({
            protocolID: config.protocolID,
            keyID: config.keyID,
            ciphertext: decoded.fields[1]
          })
          value = Utils.toUTF8(plaintext)
        } catch {
          // Fall back to plaintext for backward compatibility
          value = Utils.toUTF8(decoded.fields[1])
        }
      } else {
        value = Utils.toUTF8(decoded.fields[1])
      }

      return value
    } catch {
      return undefined
    }
  }
}

/**
 * Creates a filter function that only includes outputs matching a specific protected key
 */
export function createKVStoreKeyFilter(protectedKey: string): HistoryFilter {
  return {
    shouldInclude(transaction: Transaction, outputIndex: number): boolean {
      try {
        const output = transaction.outputs[outputIndex]
        if (!output) return false

        const decoded = PushDrop.decode(output.lockingScript)
        if (decoded.fields.length !== 3 || decoded.fields[0].length !== 32) {
          return false
        }

        const keyFromOutput = Utils.toBase64(decoded.fields[0])
        return keyFromOutput === protectedKey
      } catch {
        return false
      }
    }
  }
}
