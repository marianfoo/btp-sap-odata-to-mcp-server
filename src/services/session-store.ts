import { EntraIDUserSession } from '../types/entra-types.js';
import { Logger } from '../utils/logger.js';

/**
 * Simple in-memory session store for Entra ID authenticated users
 * 
 * POC Implementation:
 * - Stores sessions in memory (Map)
 * - No encryption (add later for production)
 * - Auto-cleanup of expired sessions
 * - Lost on server restart
 * 
 * For Production:
 * - Use Redis or similar for persistence
 * - Add encryption for sensitive data
 * - Implement distributed session management
 */
export class SessionStore {
    private sessions: Map<string, EntraIDUserSession>;
    private logger: Logger;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private sessionTimeoutMs: number;

    constructor(sessionTimeoutMs: number = 3600000, logger?: Logger) {
        this.sessions = new Map();
        this.logger = logger || new Logger('SessionStore');
        this.sessionTimeoutMs = sessionTimeoutMs;
        
        // Start automatic cleanup every 5 minutes
        this.startCleanup();
    }

    /**
     * Create or update a session
     */
    set(sessionId: string, session: EntraIDUserSession): void {
        this.sessions.set(sessionId, {
            ...session,
            lastAccessedAt: new Date()
        });
        this.logger.debug(`Session stored: ${sessionId} for user ${session.entraEmail}`);
    }

    /**
     * Get a session by ID
     */
    get(sessionId: string): EntraIDUserSession | undefined {
        const session = this.sessions.get(sessionId);
        
        if (!session) {
            return undefined;
        }

        // Check if session has expired
        const now = new Date();
        const sessionAge = now.getTime() - session.lastAccessedAt.getTime();
        
        if (sessionAge > this.sessionTimeoutMs) {
            this.logger.info(`Session expired: ${sessionId}`);
            this.delete(sessionId);
            return undefined;
        }

        // Update last accessed time
        session.lastAccessedAt = now;
        this.sessions.set(sessionId, session);
        
        return session;
    }

    /**
     * Delete a session
     */
    delete(sessionId: string): boolean {
        const deleted = this.sessions.delete(sessionId);
        if (deleted) {
            this.logger.debug(`Session deleted: ${sessionId}`);
        }
        return deleted;
    }

    /**
     * Check if a session exists
     */
    has(sessionId: string): boolean {
        return this.sessions.has(sessionId);
    }

    /**
     * Get all active session IDs
     */
    getAllSessionIds(): string[] {
        return Array.from(this.sessions.keys());
    }

    /**
     * Get number of active sessions
     */
    getSessionCount(): number {
        return this.sessions.size;
    }

    /**
     * Update SAP credential validation status
     */
    markCredentialsValidated(sessionId: string, validated: boolean): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.sapCredentialsValidated = validated;
            this.sessions.set(sessionId, session);
            this.logger.info(`SAP credentials validation status updated for session ${sessionId}: ${validated}`);
        }
    }

    /**
     * Clear all sessions (useful for testing or shutdown)
     */
    clear(): void {
        const count = this.sessions.size;
        this.sessions.clear();
        this.logger.info(`All sessions cleared (${count} sessions removed)`);
    }

    /**
     * Start automatic cleanup of expired sessions
     */
    private startCleanup(): void {
        this.cleanupInterval = setInterval(() => {
            this.cleanupExpiredSessions();
        }, 5 * 60 * 1000); // Run every 5 minutes

        this.logger.debug('Session cleanup interval started');
    }

    /**
     * Stop automatic cleanup
     */
    stopCleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            this.logger.debug('Session cleanup interval stopped');
        }
    }

    /**
     * Clean up expired sessions
     */
    private cleanupExpiredSessions(): void {
        const now = new Date();
        let expiredCount = 0;

        for (const [sessionId, session] of this.sessions.entries()) {
            const sessionAge = now.getTime() - session.lastAccessedAt.getTime();
            
            if (sessionAge > this.sessionTimeoutMs) {
                this.sessions.delete(sessionId);
                expiredCount++;
            }
        }

        if (expiredCount > 0) {
            this.logger.info(`Cleaned up ${expiredCount} expired sessions`);
        }
    }

    /**
     * Get session statistics
     */
    getStats(): {
        totalSessions: number;
        validatedSessions: number;
        unvalidatedSessions: number;
    } {
        let validated = 0;
        let unvalidated = 0;

        for (const session of this.sessions.values()) {
            if (session.sapCredentialsValidated) {
                validated++;
            } else {
                unvalidated++;
            }
        }

        return {
            totalSessions: this.sessions.size,
            validatedSessions: validated,
            unvalidatedSessions: unvalidated
        };
    }
}

