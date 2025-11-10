import { ConfidentialClientApplication, AuthorizationUrlRequest, AuthorizationCodeRequest, CryptoProvider } from '@azure/msal-node';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { Logger } from '../utils/logger.js';
import { Config } from '../utils/config.js';
import { SessionStore } from './session-store.js';
import { EntraIDConfig, EntraIDTokenClaims, EntraIDUserSession } from '../types/entra-types.js';

/**
 * Extended Express Request with Entra ID session
 */
export interface EntraIDRequest extends Request {
    entraSession?: EntraIDUserSession;
    sessionId?: string;
}

/**
 * Microsoft Entra ID Authentication Service
 * 
 * Implements OAuth 2.0 Authorization Code Flow with PKCE
 * Uses @azure/msal-node for authentication
 */
export class EntraAuthService {
    private msalClient: ConfidentialClientApplication | null = null;
    private config: EntraIDConfig | null = null;
    private logger: Logger;
    private appConfig: Config;
    private sessionStore: SessionStore;
    private cryptoProvider: CryptoProvider;

    // Store PKCE verifiers temporarily (in production, use Redis)
    private pkceVerifiers: Map<string, { verifier: string; timestamp: number }> = new Map();

    constructor(logger?: Logger, appConfig?: Config, sessionStore?: SessionStore) {
        this.logger = logger || new Logger('EntraAuthService');
        this.appConfig = appConfig || new Config();
        this.sessionStore = sessionStore || new SessionStore(
            parseInt(process.env.SESSION_TIMEOUT_MS || '3600000'),
            this.logger
        );
        this.cryptoProvider = new CryptoProvider();
        
        this.initialize();
        this.startPkceCleanup();
    }

    /**
     * Initialize Entra ID configuration and MSAL client
     */
    private initialize(): void {
        try {
            const tenantId = process.env.ENTRA_TENANT_ID;
            const clientId = process.env.ENTRA_CLIENT_ID;
            const clientSecret = process.env.ENTRA_CLIENT_SECRET;
            const redirectUri = process.env.ENTRA_REDIRECT_URI;

            if (!tenantId || !clientId || !clientSecret || !redirectUri) {
                this.logger.warn('Entra ID not configured - missing required environment variables');
                return;
            }

            const authority = `https://login.microsoftonline.com/${tenantId}`;

            this.config = {
                tenantId,
                clientId,
                clientSecret,
                redirectUri,
                authority,
                sapUsernameClaimName: process.env.ENTRA_SAP_USERNAME_CLAIM || 'extensionSAPUsername',
                sapPasswordClaimName: process.env.ENTRA_SAP_PASSWORD_CLAIM || 'extensionSAPPassword'
            };

            // Initialize MSAL Confidential Client Application
            this.msalClient = new ConfidentialClientApplication({
                auth: {
                    clientId: this.config.clientId,
                    authority: this.config.authority,
                    clientSecret: this.config.clientSecret
                },
                system: {
                    loggerOptions: {
                        loggerCallback: (level, message) => {
                            this.logger.debug(`MSAL: ${message}`);
                        },
                        piiLoggingEnabled: false,
                        logLevel: 3 // Info level
                    }
                }
            });

            this.logger.info('Entra ID authentication service initialized successfully');
        } catch (error) {
            this.logger.error('Failed to initialize Entra ID service:', error);
            this.config = null;
            this.msalClient = null;
        }
    }

    /**
     * Check if Entra ID is configured
     */
    isConfigured(): boolean {
        return this.config !== null && this.msalClient !== null;
    }

    /**
     * Get authorization URL to start OAuth flow
     */
    async getAuthorizationUrl(state?: string): Promise<string> {
        if (!this.msalClient || !this.config) {
            throw new Error('Entra ID not configured');
        }

        const authState = state || randomUUID();
        
        // Generate PKCE challenge
        const { verifier, challenge } = await this.cryptoProvider.generatePkceCodes();
        
        // Store verifier for later use in token exchange
        this.pkceVerifiers.set(authState, {
            verifier,
            timestamp: Date.now()
        });

        const authCodeUrlParameters: AuthorizationUrlRequest = {
            scopes: ['openid', 'profile', 'email', 'User.Read'],
            redirectUri: this.config.redirectUri,
            state: authState,
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
            prompt: 'select_account' // Allow user to select account
        };

        const authUrl = await this.msalClient.getAuthCodeUrl(authCodeUrlParameters);
        this.logger.info(`Generated authorization URL for state: ${authState}`);
        
        return authUrl;
    }

    /**
     * Exchange authorization code for tokens
     */
    async exchangeCodeForToken(code: string, state: string): Promise<EntraIDUserSession> {
        if (!this.msalClient || !this.config) {
            throw new Error('Entra ID not configured');
        }

        // Retrieve PKCE verifier
        const pkceData = this.pkceVerifiers.get(state);
        if (!pkceData) {
            throw new Error('Invalid state or PKCE verifier not found');
        }

        const tokenRequest: AuthorizationCodeRequest = {
            code,
            scopes: ['openid', 'profile', 'email', 'User.Read'],
            redirectUri: this.config.redirectUri,
            codeVerifier: pkceData.verifier
        };

        try {
            const response = await this.msalClient.acquireTokenByCode(tokenRequest);
            
            if (!response || !response.accessToken) {
                throw new Error('Failed to acquire token');
            }

            // Clean up PKCE verifier
            this.pkceVerifiers.delete(state);

            // Decode ID token to get claims
            const claims = response.idTokenClaims as EntraIDTokenClaims;
            
            if (!claims) {
                throw new Error('No claims found in ID token');
            }

            // Log all available claims for debugging
            this.logger.info('=== Available Token Claims ===');
            this.logger.info(`Total claims found: ${Object.keys(claims).length}`);
            for (const [key, value] of Object.entries(claims)) {
                // Don't log sensitive values in full, just show they exist
                const displayValue = typeof value === 'string' && value.length > 50 
                    ? `${value.substring(0, 20)}...` 
                    : value;
                this.logger.info(`  - ${key}: ${displayValue}`);
            }
            this.logger.info('=== End of Claims ===');

            // Extract SAP credentials from claims
            const sapUsername = claims[this.config.sapUsernameClaimName];
            const sapPassword = claims[this.config.sapPasswordClaimName];

            this.logger.info(`Looking for SAP credentials in claims:`);
            this.logger.info(`  - Username claim name: ${this.config.sapUsernameClaimName} → ${sapUsername ? 'FOUND' : 'NOT FOUND'}`);
            this.logger.info(`  - Password claim name: ${this.config.sapPasswordClaimName} → ${sapPassword ? 'FOUND' : 'NOT FOUND'}`);

            if (!sapUsername || !sapPassword) {
                throw new Error(
                    `SAP credentials not found in token claims. ` +
                    `Expected claims: ${this.config.sapUsernameClaimName}, ${this.config.sapPasswordClaimName}. ` +
                    `Please ensure these custom attributes are configured in Entra ID and included in the token. ` +
                    `Check the logs above to see all available claims.`
                );
            }

            // Create session
            const sessionId = randomUUID();
            const now = new Date();
            const expiresAt = response.expiresOn || new Date(now.getTime() + 3600000);

            const session: EntraIDUserSession = {
                sessionId,
                entraUserId: claims.oid || claims.sub,
                entraEmail: claims.email || claims.preferred_username || 'unknown',
                entraDisplayName: claims.name,
                sapUsername: sapUsername as string,
                sapPassword: sapPassword as string,
                sapCredentialsValidated: false,
                accessToken: response.accessToken,
                refreshToken: response.account?.homeAccountId, // Store account ID for token refresh
                idToken: response.idToken,
                tokenExpiresAt: expiresAt,
                createdAt: now,
                lastAccessedAt: now
            };

            // Store session
            this.sessionStore.set(sessionId, session);

            this.logger.info(`User authenticated successfully: ${session.entraEmail} (Session: ${sessionId})`);
            
            return session;

        } catch (error) {
            this.logger.error('Token exchange failed:', error);
            throw error;
        }
    }

    /**
     * Get user info from session
     */
    getUserInfo(sessionId: string): EntraIDUserSession | undefined {
        return this.sessionStore.get(sessionId);
    }

    /**
     * Destroy a session
     */
    destroySession(sessionId: string): void {
        this.sessionStore.delete(sessionId);
        this.logger.info(`Session destroyed: ${sessionId}`);
    }

    /**
     * Express middleware to authenticate requests using Entra ID session
     */
    authenticateEntraID() {
        return (req: EntraIDRequest, res: Response, next: NextFunction) => {
            // Skip authentication for certain endpoints
            if (req.path === '/health' || 
                req.path === '/docs' || 
                req.path.startsWith('/oauth/entra/')) {
                return next();
            }

            // Get session ID from cookie or header
            const sessionId = req.cookies?.entra_session_id || req.headers['x-entra-session-id'] as string;

            if (!sessionId) {
                return res.status(401).json({
                    error: 'Authentication Required',
                    message: 'No Entra ID session found',
                    authUrl: '/oauth/entra/authorize'
                });
            }

            // Get session from store
            const session = this.sessionStore.get(sessionId);

            if (!session) {
                return res.status(401).json({
                    error: 'Session Expired',
                    message: 'Your session has expired. Please login again.',
                    authUrl: '/oauth/entra/authorize'
                });
            }

            // Check if token has expired
            if (new Date() > session.tokenExpiresAt) {
                this.sessionStore.delete(sessionId);
                return res.status(401).json({
                    error: 'Token Expired',
                    message: 'Your access token has expired. Please login again.',
                    authUrl: '/oauth/entra/authorize'
                });
            }

            // Attach session to request
            req.entraSession = session;
            req.sessionId = sessionId;

            this.logger.debug(`Request authenticated for Entra ID user: ${session.entraEmail}`);
            next();
        };
    }

    /**
     * Get session store instance
     */
    getSessionStore(): SessionStore {
        return this.sessionStore;
    }

    /**
     * Get configuration
     */
    getConfig(): EntraIDConfig | null {
        return this.config;
    }

    /**
     * Clean up expired PKCE verifiers (run periodically)
     */
    private startPkceCleanup(): void {
        setInterval(() => {
            const now = Date.now();
            const maxAge = 10 * 60 * 1000; // 10 minutes

            for (const [state, data] of this.pkceVerifiers.entries()) {
                if (now - data.timestamp > maxAge) {
                    this.pkceVerifiers.delete(state);
                }
            }
        }, 5 * 60 * 1000); // Run every 5 minutes
    }

    /**
     * Get service statistics
     */
    getStats() {
        return {
            configured: this.isConfigured(),
            sessions: this.sessionStore.getStats(),
            pendingPkceVerifiers: this.pkceVerifiers.size
        };
    }
}

