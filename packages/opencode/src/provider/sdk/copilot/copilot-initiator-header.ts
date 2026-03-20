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
   * Returns the parent session ID if this is a registered child session.
   *
   * @param sessionId - The session ID to resolve
   * @returns The effective session ID (parent or self)
   */
  #getEffectiveSessionId(sessionId: string): string {
    return this.#parentSessionMap.get(sessionId) ?? sessionId;
  }

  /**
   * Get the X-Initiator value for a session.
   *
   * @param sessionId - Session identifier
   * @param threshold - Threshold (defaults to 50)
   * @returns "user" for first call or after threshold, "agent" otherwise
   */
  getInitiator(
    sessionId: string,
    threshold: number = DEFAULT_THRESHOLD,
  ): "user" | "agent" {
    // Lazy cleanup of stale data
    this.cleanup();

    // Resolve to parent session for tracking if registered
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

    // Check if this is a child whose parent has made a direct call
    // If so, add to #firstCallMade so subsequent calls continue parent's session
    if (sessionId !== effectiveSessionId && this.#directCalls.has(effectiveSessionId)) {
      this.#firstCallMade.add(effectiveSessionId);
      this.#sessionTimestamps.set(effectiveSessionId, Date.now());
      this.#agentMessageCount.set(effectiveSessionId, 0);
      // Continue with incrementing count (not a first call for the user)
      const count = 1;
      this.#agentMessageCount.set(effectiveSessionId, count);
      return "agent";
    }

    // First call - initialize tracking with effective session ID
    this.#firstCallMade.add(effectiveSessionId);
    this.#sessionTimestamps.set(effectiveSessionId, Date.now());
    this.#agentMessageCount.set(effectiveSessionId, 0);
    // Mark this session as having made a direct call
    this.#directCalls.add(effectiveSessionId);
    return "user";
  }

  /**
   * Reset all tracking for a session (called on /new, /reset, user model changes).
   * Resets both the session and its effective (parent) session.
   */
  reset(sessionId: string): void {
    const effectiveSessionId = this.#getEffectiveSessionId(sessionId);
    this.#firstCallMade.delete(effectiveSessionId);
    this.#sessionTimestamps.delete(effectiveSessionId);
    this.#agentMessageCount.delete(effectiveSessionId);
    this.#directCalls.delete(effectiveSessionId);
  }

  /**
   * Clean up stale session data (older than 24 hours).
   * Also cleans up orphaned parent session mappings.
   */
  cleanup(force = false): void {
    const now = Date.now();
    if (!force && now - this.#lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.#lastCleanup = now;

    // Clean up parent mappings for stale sessions
    for (const [child, parent] of this.#parentSessionMap) {
      const timestamp = this.#sessionTimestamps.get(parent);
      if (!timestamp || now - timestamp > CLEANUP_INTERVAL_MS) {
        this.#parentSessionMap.delete(child);
      }
    }

    // Clean up stale session data
    for (const [sessionId, timestamp] of this.#sessionTimestamps) {
      if (now - timestamp > CLEANUP_INTERVAL_MS) {
        this.#firstCallMade.delete(sessionId);
        this.#sessionTimestamps.delete(sessionId);
        this.#agentMessageCount.delete(sessionId);
        this.#directCalls.delete(sessionId);
      }
    }
  }
}

export const copilotInitiatorTracker = new CopilotInitiatorTracker();
