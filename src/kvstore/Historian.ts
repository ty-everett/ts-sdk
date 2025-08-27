import Transaction from '../transaction/Transaction.js'

/**
 * Interface for filtering which outputs should be included in history
 */
export interface HistoryFilter {
  /**
   * Determine if an output should be included in the history
   * @param transaction - The transaction containing the output
   * @param outputIndex - The index of the output to check
   * @returns True if the output should be included in history
   */
  shouldInclude(transaction: Transaction, outputIndex: number): Promise<boolean> | boolean
}

/**
 * Type for interpreter function that can decode transaction outputs
 */
export type InterpreterFunction<T> = (transaction: Transaction, outputIndex: number) => Promise<T | undefined> | T | undefined

/**
 * Simplified Historian that follows KVStore-style transaction chaining
 * Uses custom interpreters to decode outputs into typed values
 */
export class Historian<T> {
  private interpreter: InterpreterFunction<T>
  private filter?: HistoryFilter
  private debug: boolean

  constructor(
    interpreter: InterpreterFunction<T>,
    options: {
      filter?: HistoryFilter
      debug?: boolean
    } = {}
  ) {
    this.interpreter = interpreter
    this.filter = options.filter
    this.debug = options.debug ?? false
  }

  /**
   * Build history by traversing input chain from a starting transaction
   * Returns values in chronological order (oldest first)
   * 
   * @param startTransaction - The transaction to start traversal from
   * @param startOutputIndex - The output index to interpret from the start transaction (default: 0)
   * @returns Array of interpreted values in chronological order
   */
  async buildHistory(startTransaction: Transaction, startOutputIndex = 0): Promise<T[]> {
    const history: T[] = []
    const visited = new Set<string>()

    // Recursively traverse input transactions to build history
    const traverseHistory = async (transaction: Transaction): Promise<void> => {
      const txid = transaction.id('hex')

      // Prevent infinite loops
      if (visited.has(txid)) {
        if (this.debug) {
          console.log(`[Historian] Skipping already visited transaction: ${txid}`)
        }
        return
      }
      visited.add(txid)

      if (this.debug) {
        console.log(`[Historian] Processing transaction: ${txid}`)
      }

      // Check all outputs in this transaction for interpretable values
      for (let outputIndex = 0; outputIndex < transaction.outputs.length; outputIndex++) {
        try {
          // Apply filter if provided
          if (this.filter) {
            const shouldInclude = await Promise.resolve(this.filter.shouldInclude(transaction, outputIndex))
            if (!shouldInclude) continue
          }

          // Try to interpret this output
          const interpretedValue = await Promise.resolve(this.interpreter(transaction, outputIndex))

          if (interpretedValue !== undefined) {
            // Add to history - preserve all updates even if values are the same
            history.push(interpretedValue)
            if (this.debug) {
              console.log(`[Historian] Added value to history:`, interpretedValue)
            }
          }
        } catch (error) {
          if (this.debug) {
            console.log(`[Historian] Failed to interpret output ${outputIndex}:`, error)
          }
          // Skip outputs that can't be interpreted
        }
      }

      // Recursively traverse input transactions
      for (const input of transaction.inputs) {
        if (input.sourceTransaction) {
          await traverseHistory(input.sourceTransaction)
        } else if (this.debug) {
          console.log(`[Historian] Input missing sourceTransaction, skipping`)
        }
      }
    }

    // Start traversal from the provided transaction
    await traverseHistory(startTransaction)

    // History is built in reverse chronological order during traversal,
    // so we reverse it to return oldest-first
    return history.reverse()
  }

  /**
   * Get the current (tip) value from a transaction
   * 
   * @param transaction - The transaction to interpret
   * @param outputIndex - The output index to interpret (default: 0)
   * @returns The interpreted value or undefined
   */
  async getCurrentValue(transaction: Transaction, outputIndex = 0): Promise<T | undefined> {
    try {
      // Apply filter if provided
      if (this.filter) {
        const shouldInclude = await Promise.resolve(this.filter.shouldInclude(transaction, outputIndex))
        if (!shouldInclude) return undefined
      }

      return await Promise.resolve(this.interpreter(transaction, outputIndex))
    } catch (error) {
      if (this.debug) {
        console.log(`[Historian] Failed to interpret current value:`, error)
      }
      return undefined
    }
  }
}
