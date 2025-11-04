interface HostReputationEntry {
  host: string
  totalSuccesses: number
  totalFailures: number
  consecutiveFailures: number
  avgLatencyMs: number | null
  lastLatencyMs: number | null
  backoffUntil: number
  lastUpdatedAt: number
  lastError?: string
}

export interface RankedHost extends HostReputationEntry {
  score: number
}

const DEFAULT_LATENCY_MS = 1500
const LATENCY_SMOOTHING_FACTOR = 0.25
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 60_000
const FAILURE_PENALTY_MS = 400
const SUCCESS_BONUS_MS = 30
const FAILURE_BACKOFF_GRACE = 2

export class HostReputationTracker {
  private readonly stats: Map<string, HostReputationEntry>

  constructor () {
    this.stats = new Map()
  }

  reset (): void {
    this.stats.clear()
  }

  recordSuccess (host: string, latencyMs: number): void {
    const entry = this.getOrCreate(host)
    const now = Date.now()
    const safeLatency = Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : DEFAULT_LATENCY_MS
    if (entry.avgLatencyMs === null) {
      entry.avgLatencyMs = safeLatency
    } else {
      entry.avgLatencyMs =
        (1 - LATENCY_SMOOTHING_FACTOR) * entry.avgLatencyMs +
        LATENCY_SMOOTHING_FACTOR * safeLatency
    }
    entry.lastLatencyMs = safeLatency
    entry.totalSuccesses += 1
    entry.consecutiveFailures = 0
    entry.backoffUntil = 0
    entry.lastUpdatedAt = now
    entry.lastError = undefined
  }

  recordFailure (host: string, reason?: unknown): void {
    const entry = this.getOrCreate(host)
    const now = Date.now()
    entry.totalFailures += 1
    entry.consecutiveFailures += 1
    const penaltyLevel = Math.max(entry.consecutiveFailures - FAILURE_BACKOFF_GRACE, 0)
    if (penaltyLevel === 0) {
      entry.backoffUntil = 0
    } else {
      const backoffDuration = Math.min(
        MAX_BACKOFF_MS,
        BASE_BACKOFF_MS * Math.pow(2, penaltyLevel - 1)
      )
      entry.backoffUntil = now + backoffDuration
    }
    entry.lastUpdatedAt = now
    entry.lastError =
      typeof reason === 'string'
        ? reason
        : reason instanceof Error
          ? reason.message
          : undefined
  }

  rankHosts (hosts: string[], now: number = Date.now()): RankedHost[] {
    const seen = new Map<string, number>()
    hosts.forEach((host, idx) => {
      if (typeof host !== 'string' || host.length === 0) return
      if (!seen.has(host)) seen.set(host, idx)
    })

    const orderedHosts = Array.from(seen.keys())
    const ranked = orderedHosts.map((host) => {
      const entry = this.getOrCreate(host)
      return {
        ...entry,
        score: this.computeScore(entry, now),
        originalOrder: seen.get(host) ?? 0
      }
    })

    ranked.sort((a, b) => {
      const aInBackoff = a.backoffUntil > now
      const bInBackoff = b.backoffUntil > now
      if (aInBackoff !== bInBackoff) return aInBackoff ? 1 : -1
      if (a.score !== b.score) return a.score - b.score
      if (a.totalSuccesses !== b.totalSuccesses) return b.totalSuccesses - a.totalSuccesses
      return (a as any).originalOrder - (b as any).originalOrder
    })

    return ranked.map(({ originalOrder, ...rest }) => rest)
  }

  snapshot (host: string): HostReputationEntry | undefined {
    const entry = this.stats.get(host)
    return entry != null ? { ...entry } : undefined
  }

  private computeScore (entry: HostReputationEntry, now: number): number {
    const latency = entry.avgLatencyMs ?? DEFAULT_LATENCY_MS
    const failurePenalty = entry.consecutiveFailures * FAILURE_PENALTY_MS
    const successBonus = Math.min(entry.totalSuccesses * SUCCESS_BONUS_MS, latency / 2)
    const backoffPenalty = entry.backoffUntil > now ? entry.backoffUntil - now : 0
    return latency + failurePenalty + backoffPenalty - successBonus
  }

  private getOrCreate (host: string): HostReputationEntry {
    let entry = this.stats.get(host)
    if (entry == null) {
      entry = {
        host,
        totalSuccesses: 0,
        totalFailures: 0,
        consecutiveFailures: 0,
        avgLatencyMs: null,
        lastLatencyMs: null,
        backoffUntil: 0,
        lastUpdatedAt: 0
      }
      this.stats.set(host, entry)
    }
    return entry
  }
}

const globalTracker = new HostReputationTracker()

export const getOverlayHostReputationTracker = (): HostReputationTracker => globalTracker
