import FeeModel from '../FeeModel.js'
import Transaction from '../Transaction.js'

/**
 * Represents a live fee policy that fetches current rates from ARC GorillaPool.
 */
export default class LivePolicy implements FeeModel {
  private static readonly ARC_POLICY_URL = 'https://arc.gorillapool.io/v1/policy'
  private static instance: LivePolicy | null = null
  private cachedRate: number | null = null
  private cacheTimestamp: number = 0
  private readonly cacheValidityMs: number

  /**
   * Constructs an instance of the live policy fee model.
   *
   * @param {number} cacheValidityMs - How long to cache the fee rate in milliseconds (default: 5 minutes)
   */
  constructor(cacheValidityMs: number = 5 * 60 * 1000) {
    this.cacheValidityMs = cacheValidityMs
  }

  /**
   * Gets the singleton instance of LivePolicy to ensure cache sharing across the application.
   *
   * @param {number} cacheValidityMs - How long to cache the fee rate in milliseconds (default: 5 minutes)
   * @returns The singleton LivePolicy instance
   */
  static getInstance(cacheValidityMs: number = 5 * 60 * 1000): LivePolicy {
    if (!LivePolicy.instance) {
      LivePolicy.instance = new LivePolicy(cacheValidityMs)
    }
    return LivePolicy.instance
  }

  /**
   * Fetches the current fee rate from ARC GorillaPool API.
   * 
   * @returns The current satoshis per kilobyte rate
   */
  private async fetchFeeRate(): Promise<number> {
    const now = Date.now()
    
    // Return cached rate if still valid
    if (this.cachedRate !== null && (now - this.cacheTimestamp) < this.cacheValidityMs) {
      return this.cachedRate
    }

    try {
      const response = await fetch(LivePolicy.ARC_POLICY_URL)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      
      const response_data = await response.json()
      
      if (!response_data.policy?.miningFee || typeof response_data.policy.miningFee.satoshis !== 'number' || typeof response_data.policy.miningFee.bytes !== 'number') {
        throw new Error('Invalid policy response format')
      }
      
      // Convert to satoshis per kilobyte
      const rate = (response_data.policy.miningFee.satoshis / response_data.policy.miningFee.bytes) * 1000
      
      // Cache the result
      this.cachedRate = rate
      this.cacheTimestamp = now
      
      return rate
    } catch (error) {
      // If we have a cached rate, use it as fallback
      if (this.cachedRate !== null) {
        console.warn('Failed to fetch live fee rate, using cached value:', error)
        return this.cachedRate
      }
      
      // Otherwise, use a reasonable default (100 sat/kb)
      console.warn('Failed to fetch live fee rate, using default 100 sat/kb:', error)
      return 100
    }
  }

  /**
   * Computes the fee for a given transaction using the current live rate.
   *
   * @param tx The transaction for which a fee is to be computed.
   * @returns The fee in satoshis for the transaction.
   */
  async computeFee(tx: Transaction): Promise<number> {
    const rate = await this.fetchFeeRate()
    const getVarIntSize = (i: number): number => {
      if (i > 2 ** 32) {
        return 9
      } else if (i > 2 ** 16) {
        return 5
      } else if (i > 253) {
        return 3
      } else {
        return 1
      }
    }
    // Compute the (potentially estimated) size of the transaction
    let size = 4 // version
    size += getVarIntSize(tx.inputs.length) // number of inputs
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i]
      size += 40 // txid, output index, sequence number
      let scriptLength: number
      if (typeof input.unlockingScript === 'object') {
        scriptLength = input.unlockingScript.toBinary().length
      } else if (typeof input.unlockingScriptTemplate === 'object') {
        scriptLength = await input.unlockingScriptTemplate.estimateLength(
          tx,
          i
        )
      } else {
        throw new Error(
          'All inputs must have an unlocking script or an unlocking script template for sat/kb fee computation.'
        )
      }
      size += getVarIntSize(scriptLength) // unlocking script length
      size += scriptLength // unlocking script
    }
    size += getVarIntSize(tx.outputs.length) // number of outputs
    for (const out of tx.outputs) {
      size += 8 // satoshis
      const length = out.lockingScript.toBinary().length
      size += getVarIntSize(length) // script length
      size += length // script
    }
    size += 4 // lock time
    // We'll use Math.ceil to ensure the miners get the extra satoshi.
    const fee = Math.ceil((size / 1000) * rate)
    return fee
  }
}
