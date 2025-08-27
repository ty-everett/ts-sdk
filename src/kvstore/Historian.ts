import { Beef } from '../transaction/Beef.js'
import Transaction from '../transaction/Transaction.js'
import { createGenericPushDropInterpreter } from './interpreters/createGenericPushDropInterpreter.js'
import type { TokenInterpreter, KVStoreResult } from './interpreters/types.js'

/** Historian: walks a tx chain and returns values oldest -> newest */
export class Historian<T = string> {
  constructor(
    private readonly interpreter?: TokenInterpreter<T>,
    private readonly options: {
      validate?: (value: T) => boolean
      debug?: boolean
    } = {}
  ) { }

  private getInterpreter(): TokenInterpreter<T> {
    return this.interpreter ?? (createGenericPushDropInterpreter() as TokenInterpreter<T>)
  }

  private isValidToken(value: T): boolean {
    return this.options.validate ? this.options.validate(value) : true
  }

  private debug(msg: string, ...args: unknown[]): void {
    if (this.options.debug) {
      // eslint-disable-next-line no-console
      console.log(`[Historian] ${msg}`, ...args)
    }
  }

  /**
   * Find the tip (“latest”) token tx without trusting BEEF order:
   * - must have ≥1 input (skip coinbase)
   * - must decode via interpreter at output 0
   * - prefer a tx that is NOT spent by any other tx in this BEEF (a head)
   */
  private findTip(beef: Beef): Transaction | undefined {
    const txs: Transaction[] = beef.txs.map(t => t.tx).filter(Boolean as any)

    // txids referenced by inputs (i.e., parents that are spent)
    const spent = new Set<string>()
    for (const tx of txs) {
      for (const input of tx.inputs ?? []) {
        if (input?.sourceTXID) spent.add(input.sourceTXID)
      }
    }

    // Candidate token txs
    const interpreter = this.getInterpreter()
    const candidates = txs.filter(tx => {
      const hasInput = (tx.inputs?.length ?? 0) > 0
      if (!hasInput) return false
      try {
        const v = interpreter(tx, 0)
        return v !== undefined
      } catch {
        return false
      }
    })
    if (candidates.length === 0) return undefined

    // Prefer a head contained entirely within this BEEF
    const heads = candidates.filter(tx => !spent.has(tx.id('hex')))
    if (heads.length > 0) return heads[0]

    // Fallback: walk forward along parent->child among candidates
    const parentToChild = new Map<string, Transaction>()
    for (const tx of candidates) {
      const parentId = tx.inputs?.[0]?.sourceTXID
      if (parentId) parentToChild.set(parentId, tx)
    }
    const childrenIds = new Set([...parentToChild.values()].map(t => t.id('hex')))
    let cur = candidates.find(tx => !childrenIds.has(tx.id('hex'))) ?? candidates[0]
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const next = parentToChild.get(cur.id('hex'))
      if (!next) break
      cur = next
    }
    return cur
  }

  private async interpretFrom(
    beef: Beef,
    currentTx: Transaction,
    currentDepth: number,
    visited: Set<string>
  ): Promise<T[]> {
    this.debug(`Processing transaction with ${currentTx.outputs.length} outputs, ${currentTx.inputs.length} inputs`)

    const valueHistory: T[] = []

    // Decode current tx (output 0)
    try {
      const interpreter = this.getInterpreter()
      const tokenValue = await Promise.resolve(interpreter(currentTx, 0))
      if (tokenValue !== undefined && this.isValidToken(tokenValue)) {
        valueHistory.push(tokenValue)
        this.debug('Added token to history:', tokenValue)
      }
    } catch {
      // ignore decode errors
    }

    // Recurse into parents
    for (const input of currentTx.inputs ?? []) {
      const parentId = input.sourceTXID
      let parentTx: Transaction | undefined = input.sourceTransaction

      if (!parentTx && parentId) {
        this.debug(`Looking for input transaction: ${parentId}`)
        parentTx = beef.txs.find(x => x.tx?.id('hex') === parentId)?.tx
        if (parentTx) this.debug('Found input transaction in BEEF')
      }
      if (!parentTx) continue

      const pid = parentTx.id('hex')
      if (visited.has(pid)) {
        this.debug(`Skipping already-visited tx ${pid} to avoid cycles`)
        continue
      }

      visited.add(pid)
      const prev = await this.interpretFrom(beef, parentTx, currentDepth + 1, visited)
      if (prev.length > 0) valueHistory.unshift(...prev)
    }

    this.debug(`Returning ${valueHistory.length} values at depth ${currentDepth}`)
    return valueHistory
  }

  /** Public entry: returns history oldest -> newest */
  async interpret(
    data: number[] | Beef | KVStoreResult | Promise<KVStoreResult | null>,
    currentDepth = 0,
    targetTx?: Transaction
  ): Promise<Array<T>> {
    this.debug(`Interpreting at depth ${currentDepth}`)

    // Handle Promise<KVStoreResult | null> (from LocalKVStore.get())
    const resolvedData = await Promise.resolve(data)
    if (!resolvedData || (resolvedData as number[]).length === 0) {
      this.debug('No data provided')
      return []
    }

    // Extract BEEF data from various input formats
    let beef: Beef
    if (this.isKVStoreResult(resolvedData)) {
      // Handle LocalKVStore result format
      if (resolvedData.history) {
        // If history is already computed, return it directly
        return resolvedData.history as T[]
      }
      if (!resolvedData.beef) {
        this.debug('No BEEF data in KVStore result')
        return []
      }
      beef = resolvedData.beef
    } else if (Array.isArray(resolvedData)) {
      // Handle binary BEEF data
      beef = Beef.fromBinary(resolvedData)
    } else {
      // Handle Beef object
      beef = resolvedData as Beef
    }

    // Use the provided target (recursive) or compute a robust tip
    const startTx = targetTx ?? this.findTip(beef)
    if (!startTx) {
      this.debug('No suitable starting transaction found (no parseable token tx present)')
      return []
    }

    const visited = new Set<string>([startTx.id('hex')])
    return this.interpretFrom(beef, startTx, currentDepth, visited)
  }

  private isKVStoreResult(data: any): data is KVStoreResult {
    return data && typeof data === 'object' && ('value' in data || 'beef' in data || 'history' in data)
  }
}
