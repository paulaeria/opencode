import { Log } from "../../../util/log";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_THRESHOLD = 50; // Default auto-reset threshold

export class CopilotInitiatorTracker {
  private log = Log.create({ service: "copilot-initiator" });
  #firstCallMade = new Set<string>();
  #sessionTimestamps = new Map<string, number>();
  #agentMessageCount = new Map<string, number>();
  #parentSessionMap = new Map<string, string>(); // child → parent mapping
  // Track which sessions have directly made calls (not inherited from parent)
  #directCalls = new Set<string>();
  #lastCleanup = 0;

  /**
   * Register a child session with its parent for Copilot tracking.
   * Child sessions will use the parent's sessionId for X-Initiator logic.
   *
   * @param childSessionId - The child's session ID
   * @param parentSessionId - The parent's session ID to track against
   */
  registerChildSession(childSessionId: string, parentSessionId: string): void {
    this.#parentSessionMap.set(childSessionId, parentSessionId);
    this.log.debug(
      `copilot x-initiator: registered child session (child=${childSessionId}, parent=${parentSessionId})`,
    );
  }

  /**
   * Get the effective session ID for Copilot tracking.
   * Returns the root session ID in the hierarchy if this is part of a session tree.
   *
   * @param sessionId - The session ID to resolve
   * @returns The effective root session ID
   */
  #getEffectiveSessionId(sessionId: string): string {
    let current = sessionId;
    const visited = new Set<string>();
    while (this.#parentSessionMap.has(current)) {
      if (visited.has(current)) break; // Cycle protection
      visited.add(current);
      current = this.#parentSessionMap.get(current)!;
    }
    return current;
  }

  /**
   * Get the X-Initiator value for a session.
   *
   * @param sessionId - Session identifier
   * @param threshold - Threshold (defaults to 50)
   * @param cleanupInterval - Cleanup interval (defaults to 24 hours)
   * @returns "user" for first call or after threshold, "agent" otherwise
   */
  getInitiator(
    sessionId: string,
    threshold: number = DEFAULT_THRESHOLD,
    cleanupInterval: number = CLEANUP_INTERVAL_MS,
  ): "user" | "agent" {
    // Lazy cleanup of stale data
    this.cleanup(false, cleanupInterval);

    // Resolve to root session for tracking
    const effectiveSessionId = this.#getEffectiveSessionId(sessionId);

    if (this.#firstCallMade.has(effectiveSessionId)) {
      // Increment agent message count
      const count = (this.#agentMessageCount.get(effectiveSessionId) ?? 0) + 1;
      this.#agentMessageCount.set(effectiveSessionId, count);

      // Auto-reset if threshold is enabled ( > 0) AND reached
      if (threshold > 0 && count >= threshold) {
        this.log.debug(
          `copilot x-initiator: auto-reset after ${count} agent messages (sessionId=${sessionId}, effective=${effectiveSessionId})`,
        );
        this.#agentMessageCount.set(effectiveSessionId, 0);
        return "user";
      }

      this.log.debug(
        `copilot x-initiator: count=${count}/${threshold} (sessionId=${sessionId}, effective=${effectiveSessionId}, initiator=agent)`,
      );
      return "agent";
    }

    // Check if this session (or its root) has made a call in this tracker's lifetime
    if (sessionId !== effectiveSessionId && this.#directCalls.has(effectiveSessionId)) {
      this.#firstCallMade.add(effectiveSessionId);
      this.#sessionTimestamps.set(effectiveSessionId, Date.now());
      this.#agentMessageCount.set(effectiveSessionId, 1);
      return "agent";
    }

    // First call for this hierarchy - initialize tracking with effective session ID
    this.#firstCallMade.add(effectiveSessionId);
    this.#sessionTimestamps.set(effectiveSessionId, Date.now());
    this.#agentMessageCount.set(effectiveSessionId, 0);
    this.#directCalls.add(effectiveSessionId);
    return "user";
  }

  /**
   * Reset all tracking for a session (called on /new, /reset, user model changes).
   * Resets both the session and its effective (root) session.
   */
  reset(sessionId: string): void {
    const effectiveSessionId = this.#getEffectiveSessionId(sessionId);
    this.#firstCallMade.delete(effectiveSessionId);
    this.#sessionTimestamps.delete(effectiveSessionId);
    this.#agentMessageCount.delete(effectiveSessionId);
    this.#directCalls.delete(effectiveSessionId);
  }

  /**
   * Clean up stale session data (older than cleanupInterval).
   * Also cleans up orphaned parent session mappings.
   */
  cleanup(force = false, cleanupInterval: number = CLEANUP_INTERVAL_MS): void {
    const now = Date.now();
    if (!force && now - this.#lastCleanup < cleanupInterval) return;
    this.#lastCleanup = now;

    // Clean up parent mappings for stale roots
    for (const [child, parent] of this.#parentSessionMap) {
      const root = this.#getEffectiveSessionId(parent);
      const timestamp = this.#sessionTimestamps.get(root);
      if (!timestamp || now - timestamp > cleanupInterval) {
        this.#parentSessionMap.delete(child);
      }
    }

    // Clean up stale session data
    for (const [sessionId, timestamp] of this.#sessionTimestamps) {
      if (now - timestamp > cleanupInterval) {
        this.#firstCallMade.delete(sessionId);
        this.#sessionTimestamps.delete(sessionId);
        this.#agentMessageCount.delete(sessionId);
        this.#directCalls.delete(sessionId);
      }
    }
  }
}

export const copilotInitiatorTracker = new CopilotInitiatorTracker();
