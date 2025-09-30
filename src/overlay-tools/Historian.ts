import Transaction from '../transaction/Transaction.js'

/**
 * Interpreter function signature used by Historian.
 *
 * Generics:
 * - T: The decoded/typed value produced for a matching output. Returning `undefined`
 *      means “this output does not contribute to history.”
 * - C: The per-call context passed through Historian to the interpreter. This carries
 *      any metadata needed to interpret outputs (e.g., `{ protectedKey: string }` for KVStore).
 *
 * Params:
 * - tx: The transaction containing the output to interpret.
 * - outputIndex: Index of the output within `tx.outputs`.
 * - ctx: Optional context object of type C, supplied at [Historian.buildHistory(startTx, context)]
 *
 * Returns:
 * - `T | undefined` (or a Promise thereof). `undefined` indicates a non-applicable or
 *   un-decodable output for the given context.
 */
export type InterpreterFunction<T, C = unknown> =
  (tx: Transaction, outputIndex: number, ctx?: C) => Promise<T | undefined> | T | undefined

/**
 * Historian builds a chronological history (oldest → newest) of typed values by traversing
 * a transaction’s input ancestry and interpreting each output with a provided interpreter.
 *
 * Core ideas:
 * - You provide an interpreter `(tx, outputIndex) => T | undefined` that decodes one output
 *   into your domain value (e.g., kvstore entries). If it returns `undefined`, that output
 *   contributes nothing to history.
 * - Traversal follows `Transaction.inputs[].sourceTransaction` recursively, so callers must
 *   supply transactions whose inputs have `sourceTransaction` populated (e.g., via overlay
 *   history reconstruction).
 * - The traversal visits each transaction once (cycle-safe) and collects interpreted values
 *   in reverse-chronological order, then returns them as chronological (oldest-first).
 *
 * Usage:
 * - Construct with an interpreter
 * - Call historian.buildHistory(tx) to get an array of values representing the history of a token over time.
 *
 * Example:
 *   const historian = new Historian(interpreter)
 *   const history = await historian.buildHistory(tipTransaction)
 *   // history: T[] (e.g., prior values for a protected kvstore key)
 */
export class Historian<T, C = unknown> {
  private readonly interpreter: InterpreterFunction<T, C>
  private readonly debug: boolean

  constructor(
    interpreter: InterpreterFunction<T, C>,
    options?: { debug?: boolean }
  ) {
    this.interpreter = interpreter
    this.debug = options?.debug ?? false
  }

  /**
   * Build history by traversing input chain from a starting transaction
   * Returns values in chronological order (oldest first)
   *
   * @param startTransaction - The transaction to start traversal from
   * @param context - The context to pass to the interpreter
   * @returns Array of interpreted values in chronological order
   */
  async buildHistory(startTransaction: Transaction, context?: C): Promise<T[]> {
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
          // Try to interpret this output
          const interpretedValue = await Promise.resolve(this.interpreter(transaction, outputIndex, context))

          if (interpretedValue !== undefined) {
            history.push(interpretedValue)
            if (this.debug) {
              console.log('[Historian] Added value to history:', interpretedValue)
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
        if (input.sourceTransaction != null) {
          await traverseHistory(input.sourceTransaction)
        } else if (this.debug) {
          console.log('[Historian] Input missing sourceTransaction, skipping')
        }
      }
    }

    // Start traversal from the provided transaction
    await traverseHistory(startTransaction)

    // History is built in reverse chronological order during traversal,
    // so we reverse it to return oldest-first
    return history.reverse()
  }
}
