import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import 'dotenv/config';

import { MCPServer, createMCPServer } from './mcp-server.js';
import { Logger } from './utils/logger.js';
import { Config } from './utils/config.js';
import { DestinationService } from './services/destination-service.js';
import { SAPClient } from './services/sap-client.js';
import { SAPDiscoveryService } from './services/sap-discovery.js';
import { ODataService } from './types/sap-types.js';
import { ServiceDiscoveryConfigService } from './services/service-discovery-config.js';
import { AuthService, AuthRequest } from './services/auth-service.js';
import { EntraAuthService, EntraIDRequest } from './services/entra-auth-service.js';

// Global type extensions
declare global {
    var mcpProxyStates: Map<string, {
        mcpRedirectUri: string;
        state: string;
        mcpCodeChallenge?: string;
        mcpCodeChallengeMethod?: string;
        timestamp: number;
    }>;
}

// Helper function to get the correct base URL from request
function getBaseUrl(req: express.Request): string {
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');
    return `${protocol}://${host}`;
}

/**
 * Modern Express server hosting SAP MCP Server with session management
 *
 * This server provides HTTP transport for the SAP MCP server using the
 * latest streamable HTTP transport with proper session management.
 */

const logger = new Logger('btp-sap-odata-to-mcp-server');
const config = new Config();
const destinationService = new DestinationService(logger, config);
const sapClient = new SAPClient(destinationService, logger);
const sapDiscoveryService = new SAPDiscoveryService(sapClient, logger, config);
const serviceConfigService = new ServiceDiscoveryConfigService(config, logger);
const authService = new AuthService(logger, config);
const entraAuthService = new EntraAuthService(logger, config);
let discoveredServices: ODataService[] = [];

// Session storage for HTTP transport with user context
const sessions: Map<string, {
    server: MCPServer;
    transport: StreamableHTTPServerTransport;
    createdAt: Date;
    userToken?: string;
    userId?: string;
}> = new Map();

/**
 * Clean up expired sessions (older than 24 hours)
 */
function cleanupExpiredSessions(): void {
    const now = new Date();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    for (const [sessionId, session] of sessions.entries()) {
        if (now.getTime() - session.createdAt.getTime() > maxAge) {
            logger.info(`🧹 Cleaning up expired session: ${sessionId}`);
            session.transport.close();
            sessions.delete(sessionId);
        }
    }
}

/**
 * Get or create a session for the given session ID with optional user context
 */
async function getOrCreateSession(sessionId?: string, userToken?: string): Promise<{
    sessionId: string;
    server: MCPServer;
    transport: StreamableHTTPServerTransport;
}> {
    // Check for existing session
    if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        logger.debug(`♻️  Reusing existing session: ${sessionId}`);
        return {
            sessionId,
            server: session.server,
            transport: session.transport
        };
    }

    // Create new session
    const newSessionId = sessionId || randomUUID();
    logger.info(`🆕 Creating new MCP session: ${newSessionId}`);

    try {
        // Create and initialize MCP server with user token if available
        const mcpServer = await createMCPServer(discoveredServices, userToken);

        // Create HTTP transport
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            onsessioninitialized: (id) => {
                logger.debug(`✅ Session initialized: ${id}`);
            },
            enableDnsRebindingProtection: false,  // Disable for MCP inspector compatibility
            allowedHosts: ['127.0.0.1', 'localhost']
        });

        // Connect server to transport
        await mcpServer.getServer().connect(transport);

        // Store session with user context if provided
        sessions.set(newSessionId, {
            server: mcpServer,
            transport,
            createdAt: new Date(),
            userToken: userToken
        });

        // Clean up session when transport closes
        transport.onclose = () => {
            logger.info(`🔌 Transport closed for session: ${newSessionId}`);
            sessions.delete(newSessionId);
        };

        logger.info(`🎉 Session created successfully: ${newSessionId}`);
        return {
            sessionId: newSessionId,
            server: mcpServer,
            transport
        };

    } catch (error) {
        logger.error(`❌ Failed to create session: ${error}`);
        throw error;
    }
}

/**
 * Create Express application
 */
export function createApp(): express.Application {
    const app = express();

    // Security and parsing middleware
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                scriptSrc: ["'self'"],
                imgSrc: ["'self'", "data:", "https:"]
            }
        }
    }));

    app.use(cors({
        origin: process.env.NODE_ENV === 'production'
            ? ['https://your-domain.com'] // Configure for production
            : true, // Allow all origins in development
        credentials: true,
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id', 'MCP-Protocol-Version']
    }));

    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    
    // Cookie parser for Entra ID sessions
    app.use(cookieParser());
    
    // Session middleware for Entra ID
    app.use(session({
        secret: config.get<string>('session.secret', 'change-this-secret-in-production'),
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.NODE_ENV === 'production', // HTTPS only in production
            httpOnly: true,
            maxAge: config.get<number>('session.timeoutMs', 3600000) // 1 hour default
        }
    }));

    // Request logging middleware
    app.use((req, res, next) => {
        logger.debug(`📨 ${req.method} ${req.path}`, {
            sessionId: req.headers['mcp-session-id'],
            userAgent: req.headers['user-agent']
        });
        next();
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            activeSessions: sessions.size,
            version: process.env.npm_package_version || '1.0.0'
        });
    });

    // MCP server info endpoint - Authentication-aware response
    app.get('/mcp', authService.optionalAuthenticateJWT() as express.RequestHandler, (req, res) => {
        const authReq = req as AuthRequest;
        const isAuthenticated = !!authReq.authInfo;
        const baseUrl = getBaseUrl(req);
        // Build authentication-aware response
        const serverInfo = {
            name: 'btp-sap-odata-to-mcp-server',
            version: '2.0.0',
            description: 'Modern MCP server for SAP OData services with dynamic CRUD operations and OAuth authentication',
            protocol: {
                version: '2025-06-18',
                transport: 'streamable-http'
            },
            capabilities: {
                tools: { listChanged: true },
                resources: { listChanged: true },
                logging: {}
            },
            features: [
                'OAuth authentication with SAP XSUAA',
                'Dynamic SAP OData service discovery',
                'CRUD operations for all discovered entities',
                'JWT token forwarding for secure operations',
                'Dual destination support (discovery vs execution)',
                'Natural language query support',
                'Session-based HTTP transport',
                'Real-time service metadata'
            ],
            authentication: {
                type: 'OAuth 2.0 / XSUAA',
                required: true,
                status: isAuthenticated ? 'authenticated' : 'not_authenticated',
                ...(isAuthenticated ? {
                    user: authReq.authInfo ? {
                        username: authReq.authInfo.getUserName(),
                        email: authReq.authInfo.getEmail(),
                        // scopes: authReq.authInfo.getGrantedScopes()
                    } : undefined,
                    message: 'You are authenticated and ready to access SAP services'
                } : {
                    message: 'Authentication required to access SAP OData services',
                    instructions: {
                        step1: `Visit ${baseUrl}/oauth/authorize to start OAuth flow`,
                        step2: 'Login with SAP BTP credentials',
                        step3: 'Copy access token from callback',
                        step4: 'Use token in Authorization header for MCP requests'
                    },
                    endpoints: {
                        authorize: `${baseUrl}/oauth/authorize`,
                        discovery: `${baseUrl}/.well-known/oauth-authorization-server`
                    }
                })
            },
            userGuidance: {
                gettingStarted: [
                    '1. Authenticate: Navigate to /oauth/authorize to get your access token',
                    '2. Connect: Use the token in Authorization header for MCP requests',
                    '3. Discover ONCE: Use discover-sap-data to find services and entities (returns complete schemas)',
                    '4. Execute: Use execute-sap-operation to read, create, update, or delete data'
                ],
                availableOperations: [
                    'Search SAP OData services, entities, and properties with discover-sap-data (SINGLE CALL)',
                    'Read entity collections with OData query options ($filter, $select, etc.)',
                    'Read individual entities by key',
                    'Create new entities with proper validation',
                    'Update existing entities (PATCH operations)',
                    'Delete entities with proper authorization'
                ],
                bestPractices: [
                    'Call discover-sap-data ONCE - it returns complete schemas with all details',
                    'DO NOT call discover-sap-data multiple times with different queries',
                    'Check entity capabilities (creatable, updatable, deletable) in discovery response',
                    'Use OData query options to filter and limit data retrieval',
                    'JWT tokens expire - refresh when needed via /oauth/refresh'
                ]
            },
            endpoints: {
                health: '/health',
                mcp: '/mcp',
                auth: '/oauth/authorize',
                userinfo: '/oauth/userinfo',
                docs: '/docs'
            },
            activeSessions: sessions.size,
            claude_ai_guidance: isAuthenticated ? {
                status: 'Ready to assist with SAP operations',
                available_tools: [
                    'discover-sap-data: SINGLE-USE tool - returns complete schemas (call ONCE)',
                    'execute-sap-operation: Perform CRUD operations on entities'
                ],
                next_steps: [
                    'Call discover-sap-data ONCE to get complete service/entity schemas',
                    'Immediately execute operations using data from discovery response',
                    'DO NOT call discover-sap-data multiple times'
                ]
            } : {
                status: 'Authentication required before I can help with SAP operations',
                action_required: 'User must authenticate via OAuth flow',
                guidance: [
                    'Direct user to authenticate first via OAuth',
                    'Explain the dual authentication model',
                    'Provide clear step-by-step authentication instructions',
                    'Wait for user to complete authentication before attempting SAP operations'
                ],
                authentication_priority: 'CRITICAL - Do not attempt SAP operations without authentication'
            }
        };

        res.json(serverInfo);
    });

    // Main MCP endpoint - handles all MCP communication
    // SECURITY: Optional authentication - allows Claude Desktop to connect without OAuth
    app.post('/mcp', authService.authenticateJWT() as express.RequestHandler, async (req, res) => {
        const authReq = req as AuthRequest;
        try {
            // Get session ID from header
            const sessionId = authReq.headers['mcp-session-id'] as string | undefined;
            let session;

            if (sessionId && sessions.has(sessionId)) {
                // Reuse existing session
                session = await getOrCreateSession(sessionId, authReq.jwtToken);
            } else if (!sessionId && isInitializeRequest(authReq.body)) {
                // New initialization request with user token if available
                session = await getOrCreateSession(undefined, authReq.jwtToken);
            } else {
                // Invalid request
                logger.warn(`❌ Invalid MCP request - no session ID and not initialize request`);
                return res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: No valid session ID provided or not an initialize request'
                    },
                    id: authReq.body?.id || null
                });
            }

            // Handle the request
            await session.transport.handleRequest(authReq, res, authReq.body);

        } catch (error) {
            logger.error('❌ Error handling MCP request:', error);

            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}`
                    },
                    id: authReq.body?.id || null
                });
            }
        }
    });

    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', async (req, res) => {
        try {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;

            if (!sessionId || !sessions.has(sessionId)) {
                logger.warn(`❌ Invalid session ID for SSE: ${sessionId}`);
                return res.status(400).json({
                    error: 'Invalid or missing session ID'
                });
            }

            const session = sessions.get(sessionId)!;
            await session.transport.handleRequest(req, res);

        } catch (error) {
            logger.error('❌ Error handling SSE request:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    });

    // Handle session termination
    app.delete('/mcp', async (req, res) => {
        try {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;

            if (!sessionId || !sessions.has(sessionId)) {
                logger.warn(`❌ Cannot terminate - invalid session ID: ${sessionId}`);
                return res.status(400).json({
                    error: 'Invalid or missing session ID'
                });
            }

            const session = sessions.get(sessionId)!;

            // Handle the termination request
            await session.transport.handleRequest(req, res);

            // Clean up session
            sessions.delete(sessionId);
            logger.info(`🗑️  Session terminated: ${sessionId}`);

        } catch (error) {
            logger.error('❌ Error terminating session:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    });

    // Handle HEAD requests to /mcp (for health checks)
    app.head('/mcp', (req, res) => {
        res.status(200).end();
    });

    // OAuth Discovery Endpoints - RFC 8414 and OpenID Connect Discovery compliant

    // OAuth 2.0 Authorization Server Metadata (RFC 8414) - Support both with and without /mcp suffix
    app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], (req, res) => {
        try {
            if (!authService.isConfigured()) {
                return res.status(501).json({
                    error: 'OAuth not configured',
                    message: 'XSUAA service is not configured for this deployment',
                    setup_required: 'Bind XSUAA service to this application'
                });
            }

            const xsuaaMetadata = authService.getXSUAADiscoveryMetadata()!;
            // const appScopes = authService.getApplicationScopes();
            const baseUrl = getBaseUrl(req);
            const discoveryMetadata = {
                // Core OAuth 2.0 Authorization Server Metadata
                issuer: xsuaaMetadata.issuer,
                authorization_endpoint: `${baseUrl}/oauth/authorize`,//xsuaaMetadata.endpoints.authorization,
                token_endpoint: `${baseUrl}/oauth/token`,//xsuaaMetadata.endpoints.token,
                userinfo_endpoint: `${baseUrl}/oauth/userinfo`,//xsuaaMetadata.endpoints.userinfo,
                revocation_endpoint: `${baseUrl}/oauth/revoke`,//xsuaaMetadata.endpoints.revocation,
                introspection_endpoint: `${baseUrl}/oauth/introspect`,//xsuaaMetadata.endpoints.introspection,

                // Client Registration Endpoint (RFC 7591) - Static client support
                registration_endpoint: `${baseUrl}/oauth/client-registration`,

                // Supported response types
                response_types_supported: [
                    'code',
                    // 'token',
                    // 'id_token',
                    // 'code token',
                    // 'code id_token',
                    // 'token id_token',
                    // 'code token id_token'
                ],

                // Supported grant types
                grant_types_supported: [
                    'authorization_code',
                    'refresh_token'
                ],

                // Client Registration Support (RFC 7591)
                registration_endpoint_auth_methods_supported: [
                    'none'  // No authentication required for static client registration
                ],
                client_registration_types_supported: [
                    'static'  // Support for static client credentials
                ],

                // Supported scopes (XSUAA + application scopes)
                // scopes_supported: [
                //     'openid',
                //     'profile',
                //     'email',
                //     'uaa.user',
                //     'uaa.resource',
                //     ...appScopes
                // ],

                // Supported authentication methods
                // token_endpoint_auth_methods_supported: [
                //     'client_secret_basic',
                //     'client_secret_post',
                //     'private_key_jwt'
                // ],

                // Supported claim types and claims
                // claim_types_supported: ['normal'],
                // claims_supported: [
                //     'sub',
                //     'iss',
                //     'aud',
                //     'exp',
                //     'iat',
                //     'auth_time',
                //     'jti',
                //     'client_id',
                //     'scope',
                //     'zid',
                //     'origin',
                //     'user_name',
                //     'email',
                //     'given_name',
                //     'family_name',
                //     'phone_number'
                // ],

                // PKCE support
                code_challenge_methods_supported: ['S256'],

                // Service documentation
                service_documentation: `${baseUrl}/docs`,

                // Additional XSUAA specific metadata
                'x-xsuaa-metadata': {
                    // xsappname: xsuaaMetadata.xsappname,
                    client_id: xsuaaMetadata.clientId,
                    identityZone: xsuaaMetadata.identityZone,
                    tenantMode: xsuaaMetadata.tenantMode
                },

                // MCP-specific extensions
                'x-mcp-server': {
                    name: 'btp-sap-odata-to-mcp-server',
                    version: '2.0.0',
                    mcp_endpoint: `${baseUrl}/mcp`,
                    authentication_required: true,
                    capabilities: [
                        'SAP OData service discovery',
                        'CRUD operations with JWT forwarding',
                        'Dual authentication model',
                        'Session-based MCP transport',
                        'Scope-based authorization'
                    ]
                },

                // MCP Static Client Support
                'x-mcp-static-client': {
                    supported: true,
                    registration_endpoint: `${baseUrl}/oauth/client-registration`,
                    client_id: xsuaaMetadata.clientId,
                    client_authentication_method: 'client_secret_basic'
                }
            };

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.json(discoveryMetadata);
        } catch (error) {
            logger.error('Failed to generate OAuth discovery metadata:', error);
            res.status(500).json({
                error: 'Failed to generate discovery metadata',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });

    // Static Client Registration Endpoint (RFC 7591 alternative for XSUAA)
    app.post('/oauth/client-registration', (req, res) => {
        try {
            if (!authService.isConfigured()) {
                return res.status(501).json({
                    error: 'OAuth not configured',
                    message: 'XSUAA service is not configured for this deployment'
                });
            }

            const xsuaaCredentials = authService.getServiceInfo();
            if (!xsuaaCredentials) {
                return res.status(501).json({
                    error: 'OAuth not configured',
                    message: 'XSUAA service credentials not available'
                });
            }
            // Use xsuaaCredentials variable
            void xsuaaCredentials;

            // Get client credentials including secret (sensitive operation)
            const clientCredentials = authService.getClientCredentials();
            if (!clientCredentials) {
                return res.status(501).json({
                    error: 'OAuth credentials not available',
                    message: 'XSUAA client credentials not configured'
                });
            }

            const baseUrl = getBaseUrl(req);

            // Return static client registration response per RFC 7591
            const clientRegistrationResponse = {
                client_id: clientCredentials.client_id,
                client_secret: clientCredentials.client_secret,
                client_id_issued_at: Math.floor(Date.now() / 1000),
                client_secret_expires_at: 0, // Never expires for static clients

                // OAuth 2.0 Client Metadata
                redirect_uris: [
                    `${baseUrl}/oauth/callback`
                ],
                grant_types: [
                    'authorization_code',
                    'refresh_token'
                ],
                response_types: [
                    'code'
                ],
                client_name: 'SAP BTP OData MCP Server',
                client_uri: baseUrl,

                // Token endpoint authentication method
                token_endpoint_auth_method: 'client_secret_basic',

                // XSUAA specific metadata
                'x-xsuaa-metadata': {
                    url: clientCredentials.url,
                    identityzone: clientCredentials.identityZone,
                    tenantmode: clientCredentials.tenantMode,
                    uaadomain: clientCredentials.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
                },

                // MCP-specific metadata
                'x-mcp-integration': {
                    server_name: 'btp-sap-odata-to-mcp-server',
                    mcp_endpoint: `${baseUrl}/mcp`,
                    authentication_flow: 'authorization_code',
                    supports_refresh: true
                },

                // Static client indicator
                registration_client_uri: `${baseUrl}/oauth/client-registration`,
                client_registration_type: 'static'
            };

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.json(clientRegistrationResponse);

        } catch (error) {
            logger.error('Failed to handle client registration:', error);
            res.status(500).json({
                error: 'registration_failed',
                error_description: `Client registration failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
        }
    });

    // GET version of client registration for static client discovery
    app.get('/oauth/client-registration', (req, res) => {
        try {
            if (!authService.isConfigured()) {
                return res.status(501).json({
                    error: 'OAuth not configured',
                    message: 'XSUAA service is not configured for this deployment'
                });
            }

            // const xsuaaCredentials = authService.getServiceInfo();
            const baseUrl = getBaseUrl(req);

            // Return minimal client information for GET requests
            const clientInfo = {
                registration_endpoint: `${baseUrl}/oauth/client-registration`,
                client_registration_types_supported: ['static'],
                registration_endpoint_auth_methods_supported: ['none'],
                static_client_available: true,

                // MCP integration info
                'x-mcp-integration': {
                    server_name: 'btp-sap-odata-to-mcp-server',
                    mcp_endpoint: `${baseUrl}/mcp`,
                    authentication_required: true,
                    static_client_supported: true
                }
            };

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.json(clientInfo);

        } catch (error) {
            logger.error('Failed to handle client registration info:', error);
            res.status(500).json({
                error: 'server_error',
                error_description: `Failed to get client registration info: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
        }
    });

    // Custom OAuth metadata endpoint with MCP-specific information
    app.get('/oauth/.well-known/oauth_metadata', (req, res) => {
        try {
            const baseUrl = getBaseUrl(req);
            const xsuaaInfo = authService.getServiceInfo();
            // const appScopes = authService.getApplicationScopes();

            if (!xsuaaInfo) {
                return res.status(501).json({
                    error: 'OAuth not configured',
                    message: 'XSUAA service is not configured',
                    setup_instructions: {
                        step1: 'Create XSUAA service instance in SAP BTP',
                        step2: 'Bind XSUAA service to this application',
                        step3: 'Configure xs-security.json with required scopes',
                        step4: 'Restart application to load XSUAA configuration'
                    }
                });
            }

            const metadata = {
                server: {
                    name: 'SAP BTP XSUAA OAuth Server via MCP',
                    version: '2.0.0',
                    description: 'OAuth 2.0 and OpenID Connect server for SAP OData MCP access',
                    provider: 'SAP BTP XSUAA Service'
                },

                xsuaa_service: {
                    url: xsuaaInfo.url,
                    // xsappname: xsuaaInfo.xsappname,
                    client_id: xsuaaInfo.clientId,
                    identityZone: xsuaaInfo.identityZone,
                    tenantMode: xsuaaInfo.tenantMode,
                    configured: xsuaaInfo.configured
                },

                endpoints: {
                    // Local MCP server endpoints
                    authorization: `${baseUrl}/oauth/authorize`,
                    token_refresh: `${baseUrl}/oauth/refresh`,
                    userinfo: `${baseUrl}/oauth/userinfo`,

                    // XSUAA service endpoints
                    xsuaa_authorization: `${xsuaaInfo.url}/oauth/authorize`,
                    xsuaa_token: `${xsuaaInfo.url}/oauth/token`,
                    xsuaa_userinfo: `${xsuaaInfo.url}/userinfo`,
                    xsuaa_jwks: `${xsuaaInfo.url}/token_keys`,

                    // Discovery endpoints
                    oauth_discovery: `${baseUrl}/.well-known/oauth-authorization-server`,
                    openid_discovery: `${baseUrl}/.well-known/openid_configuration`
                },

                // application_scopes: appScopes,

                supported_features: [
                    'Authorization Code Flow'
                ],

                security: {
                    token_lifetime: 3600, // 1 hour
                    refresh_token_lifetime: 86400, // 24 hours
                    supported_algorithms: ['RS256'],
                    requires_https: process.env.NODE_ENV === 'production',
                    pkce_required: false
                },

                mcp_integration: {
                    mcp_server: `${baseUrl}/mcp`,
                    authentication_required: true,
                    dual_destinations: {
                        discovery: 'Technical user for service discovery',
                        execution: 'JWT token forwarding for data operations'
                    },
                    session_management: 'Automatic with user token context',
                    health_check: `${baseUrl}/health`,
                    documentation: `${baseUrl}/docs`
                },

                usage_instructions: {
                    step1: `Visit ${baseUrl}/oauth/authorize to initiate OAuth flow`,
                    step2: 'Login with SAP BTP credentials',
                    step3: 'Copy the access token from the callback response',
                    step4: `Use token in Authorization header for ${baseUrl}/mcp requests`
                }
            };

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=1800'); // 30 minutes
            res.json(metadata);
        } catch (error) {
            logger.error('Failed to generate OAuth metadata:', error);
            res.status(500).json({
                error: 'Failed to generate OAuth metadata',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });

    // OAuth endpoints for XSUAA authentication
    app.get('/oauth/authorize', (req, res) => {
        logger.info(`Start OAuth authorization flow`);
        try {
            if (!authService.isConfigured()) {
                return res.status(501).json({
                    error: 'OAuth not configured',
                    message: 'XSUAA service is not configured for this deployment'
                });
            }

            const state = req.query.state as string || randomUUID();
            const baseUrl = getBaseUrl(req);
            const mcpRedirectUri = req.query.redirect_uri as string;// || baseUrl;
            const authUrl = authService.getAuthorizationUrl(state, baseUrl);
            const mcpCodeChallenge = req.query.code_challenge as string;
            const mcpCodeChallengeMethod = req.query.code_challenge_method as string;


            if (!mcpRedirectUri) {
                return res.status(400).json({
                    error: 'Missing redirect_uri parameter',
                    message: 'MCP Inspector redirect URI is required'
                });
            }


            // Store mapping in a simple in-memory store (you might want to use Redis in production)
            if (!globalThis.mcpProxyStates) {
                globalThis.mcpProxyStates = new Map();
            }
            globalThis.mcpProxyStates.set(state, {
                mcpRedirectUri,
                state,
                mcpCodeChallenge,
                mcpCodeChallengeMethod,
                timestamp: Date.now()
            });

            // Clean up old states (older than 10 minutes)
            for (const [key, value] of globalThis.mcpProxyStates.entries()) {
                if (Date.now() - value.timestamp > 600000) {
                    globalThis.mcpProxyStates.delete(key);
                }
            }

            logger.info(`MCP OAuth proxy initiated for redirect: ${mcpRedirectUri}`);

            logger.info(`Authorize proxy redirecting to : ${authUrl}`);
            res.redirect(authUrl);
        } catch (error) {
            logger.error('Failed to initiate OAuth flow:', error);
            res.status(500).json({ error: 'Failed to initiate OAuth flow' });
        }
    });

    // OAuth endpoint for token exchange
    const tokenHandler = async (req: Request, res: Response) => {
        logger.info(`Start OAuth token exchange flow - grant_type: ${req.body?.grant_type}`);
        const baseUrl = getBaseUrl(req);
        try {
            if (!authService.isConfigured()) {
                return res.status(501).json({
                    error: 'oauth_not_configured',
                    error_description: 'XSUAA service is not configured for this deployment'
                });
            }

            const grantType = req.body?.grant_type;
            let tokenData;

            if (grantType === 'authorization_code' || req.body?.code) {
                // Authorization code flow
                const code = req.body.code;
                if (!code) {
                    return res.status(400).json({
                        error: 'invalid_request',
                        error_description: 'Missing required parameter: code'
                    });
                }
                logger.info('Processing authorization_code grant');
                tokenData = await authService.exchangeCodeForToken(code, authService.getRedirectUri(baseUrl));
            } else if (grantType === 'refresh_token' || req.body?.refresh_token) {
                // Refresh token flow
                const refreshToken = req.body.refresh_token;
                if (!refreshToken) {
                    return res.status(400).json({
                        error: 'invalid_request',
                        error_description: 'Missing required parameter: refresh_token'
                    });
                }
                logger.info('Processing refresh_token grant');
                tokenData = await authService.refreshAccessToken(refreshToken);
            } else {
                return res.status(400).json({
                    error: 'unsupported_grant_type',
                    error_description: 'Supported grant types: authorization_code, refresh_token'
                });
            }

            logger.info(`OAuth token exchange successful - grant_type: ${grantType}`);
            res.json(tokenData);
        } catch (error) {
            logger.error('OAuth token exchange failed:', error);
            res.status(400).json({
                error: 'invalid_grant',
                error_description: error instanceof Error ? error.message : 'Token exchange failed'
            });
        }
    };
    app.get('/oauth/token', tokenHandler);
    app.post('/oauth/token', tokenHandler);
    // OAuth callback endpoint - Enhanced with HTML response option and MCP Inspector proxy support
    app.get('/oauth/callback', async (req, res) => {
        logger.info(`Start OAuth callback handling`);
        try {
            const code = req.query.code as string;
            const state = req.query.state as string;
            const format = req.query.format as string || 'html'; // Default to HTML for better UX
            const acceptHeader = req.headers.accept || '';
            const error = req.query.error as string;

            if (error) {
                const errorMsg = req.query.error_description as string || error;
                if (format === 'json' || acceptHeader.includes('application/json')) {
                    return res.status(400).json({
                        error: 'OAuth Authorization Failed',
                        message: errorMsg,
                        details: 'XSUAA authorization was denied or failed'
                    });
                } else {
                    return res.status(400).send(`
                        <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                            <h1>❌ Authentication Failed</h1>
                            <p>${errorMsg}</p>
                            <a href="/oauth/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
                        </body></html>
                    `);
                }
            }

            if (!code) {
                if (format === 'json' || acceptHeader.includes('application/json')) {
                    return res.status(400).json({ error: 'Authorization code not provided' });
                } else {
                    return res.status(400).send(`
                        <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                            <h1>❌ Authentication Failed</h1>
                            <p>Authorization code not provided.</p>
                            <a href="/oauth/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
                        </body></html>
                    `);
                }
            }

            // Check if this is a MCP Inspector proxy callback
            const mcpProxyStates = globalThis.mcpProxyStates;
            const mcpInfo = state && mcpProxyStates?.get(state);

            // const baseUrl = getBaseUrl(req);
            if (!mcpInfo) {
                logger.warn(`MCP state not found for state: ${state}`);
                return res.status(400).send(`
                    <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                        <h1>❌ Authentication Failed</h1>
                        <p>MCP state not found.</p>
                        <a href="/oauth/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
                    </body></html>
                `);
            }

            const callbackUrl = new URL(mcpInfo.mcpRedirectUri);

            // Use fragment-based response (implicit flow style) for better compatibility
            const params = new URLSearchParams({
                code,
                state
            }).toString();

            logger.info(`MCP Inspector OAuth proxy successful, redirecting to: ${mcpInfo.mcpRedirectUri}`);
            logger.info(`Callback redirect URL: ${callbackUrl.toString()}?${new URLSearchParams(params)}`);
            return res.redirect(`${callbackUrl.toString()}?${new URLSearchParams(params)}`);


        } catch (error) {
            logger.error('OAuth callback failed:', error);

            if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
                res.status(500).json({
                    error: 'Authentication failed',
                    details: error instanceof Error ? error.message : 'Unknown error'
                });
            } else {
                res.status(500).send(`
                    <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                        <h1>❌ Authentication Failed</h1>
                        <p>Error: ${error instanceof Error ? error.message : 'Unknown error'}</p>
                        <a href="/oauth/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
                    </body></html>
                `);
            }
        }
    });

    // Token refresh endpoint - Alternative endpoint for refresh (also handled by /oauth/token)
    app.post('/oauth/refresh', async (req, res) => {
        try {
            const refreshToken = req.body?.refreshToken || req.body?.refresh_token;
            if (!refreshToken) {
                return res.status(400).json({
                    error: 'invalid_request',
                    error_description: 'Refresh token not provided. Include refreshToken or refresh_token in request body.'
                });
            }

            logger.info('Processing token refresh via /oauth/refresh endpoint');
            const tokenData = await authService.refreshAccessToken(refreshToken);
            logger.info('Token refresh successful');
            res.json(tokenData);
        } catch (error) {
            logger.error('Token refresh failed:', error);
            res.status(401).json({
                error: 'invalid_grant',
                error_description: error instanceof Error ? error.message : 'Token refresh failed'
            });
        }
    });

    // ============================================================================
    // Microsoft Entra ID OAuth Endpoints (Alternative Authentication)
    // ============================================================================

    // Entra ID Authorization endpoint - Start OAuth flow
    app.get('/oauth/entra/authorize', async (req, res) => {
        logger.info('Starting Entra ID authorization flow');
        
        try {
            if (!entraAuthService.isConfigured()) {
                return res.status(501).json({
                    error: 'Entra ID not configured',
                    message: 'Microsoft Entra ID authentication is not configured. Please set ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, and ENTRA_REDIRECT_URI environment variables.',
                    documentation: '/docs/entra-id-setup'
                });
            }

            const authUrl = await entraAuthService.getAuthorizationUrl();
            logger.info('Redirecting to Entra ID authorization URL');
            res.redirect(authUrl);
            
        } catch (error) {
            logger.error('Failed to initiate Entra ID OAuth flow:', error);
            res.status(500).json({
                error: 'Authorization failed',
                message: error instanceof Error ? error.message : 'Failed to start authorization'
            });
        }
    });

    // Entra ID Callback endpoint - Handle OAuth callback
    app.get('/oauth/entra/callback', async (req, res) => {
        logger.info('Handling Entra ID OAuth callback');
        
        try {
            const code = req.query.code as string;
            const state = req.query.state as string;
            const error = req.query.error as string;

            if (error) {
                const errorDescription = req.query.error_description as string || error;
                logger.error(`Entra ID authorization error: ${errorDescription}`);
                return res.status(400).send(`
                    <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                        <h1>❌ Authentication Failed</h1>
                        <p>${errorDescription}</p>
                        <a href="/oauth/entra/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #0078d4; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
                    </body></html>
                `);
            }

            if (!code || !state) {
                logger.error('Missing code or state in Entra ID callback');
                return res.status(400).send(`
                    <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                        <h1>❌ Authentication Failed</h1>
                        <p>Authorization code not provided.</p>
                        <a href="/oauth/entra/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #0078d4; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
                    </body></html>
                `);
            }

            // Exchange code for tokens and create session
            const session = await entraAuthService.exchangeCodeForToken(code, state);
            
            // Set session cookie
            res.cookie('entra_session_id', session.sessionId, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                maxAge: config.get<number>('session.timeoutMs', 3600000),
                sameSite: 'lax'
            });

            logger.info(`Entra ID authentication successful for user: ${session.entraEmail}`);

            // Return success page with session info
            res.send(`
                <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                    <h1>✅ Authentication Successful</h1>
                    <p>Welcome, ${session.entraDisplayName || session.entraEmail}!</p>
                    <div style="margin: 2rem auto; padding: 1rem; background: #f0f0f0; border-radius: 8px; max-width: 600px; text-align: left;">
                        <h3>Session Information:</h3>
                        <p><strong>Email:</strong> ${session.entraEmail}</p>
                        <p><strong>SAP Username:</strong> ${session.sapUsername}</p>
                        <p><strong>Session ID:</strong> ${session.sessionId}</p>
                        <p><strong>Session Expires:</strong> ${new Date(Date.now() + config.get<number>('session.timeoutMs', 3600000)).toLocaleString()}</p>
                    </div>
                    <p>You can now use the MCP server with your authenticated session.</p>
                    <div style="margin-top: 2rem;">
                        <a href="/oauth/entra/userinfo" style="display: inline-block; padding: 0.5rem 1rem; background: #0078d4; color: white; text-decoration: none; border-radius: 4px; margin: 0.5rem;">View User Info</a>
                        <a href="/health" style="display: inline-block; padding: 0.5rem 1rem; background: #107c10; color: white; text-decoration: none; border-radius: 4px; margin: 0.5rem;">Server Health</a>
                    </div>
                </body></html>
            `);

        } catch (error) {
            logger.error('Entra ID callback failed:', error);
            res.status(500).send(`
                <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                    <h1>❌ Authentication Failed</h1>
                    <p>Error: ${error instanceof Error ? error.message : 'Unknown error'}</p>
                    <a href="/oauth/entra/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #0078d4; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
                </body></html>
            `);
        }
    });

    // Entra ID User Info endpoint
    app.get('/oauth/entra/userinfo', (req, res) => {
        const sessionId = req.cookies?.entra_session_id;

        if (!sessionId) {
            return res.status(401).json({
                error: 'Not authenticated',
                message: 'No Entra ID session found. Please authenticate first.',
                authUrl: '/oauth/entra/authorize'
            });
        }

        const session = entraAuthService.getUserInfo(sessionId);

        if (!session) {
            return res.status(401).json({
                error: 'Session expired',
                message: 'Your session has expired. Please authenticate again.',
                authUrl: '/oauth/entra/authorize'
            });
        }

        res.json({
            entraUserId: session.entraUserId,
            entraEmail: session.entraEmail,
            entraDisplayName: session.entraDisplayName,
            sapUsername: session.sapUsername,
            sapCredentialsValidated: session.sapCredentialsValidated,
            sessionId: session.sessionId,
            createdAt: session.createdAt,
            lastAccessedAt: session.lastAccessedAt,
            tokenExpiresAt: session.tokenExpiresAt
        });
    });

    // Entra ID Logout endpoint
    app.post('/oauth/entra/logout', (req, res) => {
        const sessionId = req.cookies?.entra_session_id;

        if (sessionId) {
            entraAuthService.destroySession(sessionId);
            res.clearCookie('entra_session_id');
            logger.info(`User logged out: ${sessionId}`);
        }

        res.json({
            message: 'Logged out successfully'
        });
    });

    // Entra ID Stats endpoint (for monitoring)
    app.get('/oauth/entra/stats', (req, res) => {
        if (!entraAuthService.isConfigured()) {
            return res.status(501).json({
                error: 'Entra ID not configured'
            });
        }

        const stats = entraAuthService.getStats();
        res.json(stats);
    });

    // ============================================================================
    // MCP Endpoint for Entra ID Authenticated Users
    // ============================================================================

    // MCP endpoint for Entra ID authenticated users
    app.post('/mcp-entra', async (req: EntraIDRequest, res: Response) => {
        try {
            // Get Entra ID session
            const sessionId = req.cookies?.entra_session_id;
            
            if (!sessionId) {
                return res.status(401).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Authentication Required: No Entra ID session found. Please authenticate at /oauth/entra/authorize'
                    },
                    id: req.body?.id || null
                });
            }

            const entraSession = entraAuthService.getUserInfo(sessionId);
            
            if (!entraSession) {
                return res.status(401).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Session Expired: Please re-authenticate at /oauth/entra/authorize'
                    },
                    id: req.body?.id || null
                });
            }

            // Get or create MCP session for this Entra ID user
            const mcpSessionId = `entra-${sessionId}`;
            let mcpSession;

            if (sessions.has(mcpSessionId)) {
                mcpSession = sessions.get(mcpSessionId)!;
                logger.debug(`♻️  Reusing MCP session for Entra ID user: ${entraSession.entraEmail}`);
            } else if (isInitializeRequest(req.body)) {
                logger.info(`🆕 Creating new MCP session for Entra ID user: ${entraSession.entraEmail}`);
                
                // Create MCP server with user-specific SAP credentials
                // Note: We'll need to modify createMCPServer to accept user credentials
                const mcpServer = await createMCPServer(discoveredServices);
                
                // Create HTTP transport
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => mcpSessionId,
                    onsessioninitialized: (id) => {
                        logger.debug(`✅ MCP session initialized for Entra ID user: ${id}`);
                    },
                    enableDnsRebindingProtection: false,
                    allowedHosts: ['127.0.0.1', 'localhost']
                });

                // Connect server to transport
                await mcpServer.getServer().connect(transport);

                // Store MCP session
                mcpSession = {
                    server: mcpServer,
                    transport,
                    createdAt: new Date(),
                    userId: entraSession.entraEmail
                };
                sessions.set(mcpSessionId, mcpSession);

                // Clean up MCP session when transport closes
                transport.onclose = () => {
                    logger.info(`🔌 MCP transport closed for Entra ID user: ${entraSession.entraEmail}`);
                    sessions.delete(mcpSessionId);
                };

                logger.info(`🎉 MCP session created for Entra ID user: ${entraSession.entraEmail}`);
            } else {
                return res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: No valid MCP session and not an initialize request'
                    },
                    id: req.body?.id || null
                });
            }

            // Attach Entra session to request for potential use in tools
            req.entraSession = entraSession;
            req.sessionId = sessionId;

            // Handle the MCP request
            await mcpSession.transport.handleRequest(req, res, req.body);

        } catch (error) {
            logger.error('❌ Error handling Entra ID MCP request:', error);

            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}`
                    },
                    id: req.body?.id || null
                });
            }
        }
    });

    // API documentation endpoint
    app.get('/docs', (req, res) => {
        res.json({
            title: 'SAP MCP Server API',
            description: 'Modern Model Context Protocol server for SAP SAP OData services',
            version: '2.0.0',
            endpoints: {
                'GET /health': 'Health check endpoint',
                'GET /mcp': 'MCP server information and SSE endpoint',
                'POST /mcp': 'Main MCP communication endpoint',
                'DELETE /mcp': 'Session termination endpoint',
                'GET /docs': 'This API documentation',
                'GET /.well-known/oauth-authorization-server': 'OAuth 2.0 Authorization Server Metadata (RFC 8414)',
                'GET /.well-known/openid_configuration': 'OpenID Connect Discovery Configuration',
                'GET /oauth/.well-known/oauth_metadata': 'Custom OAuth metadata with MCP integration info',
                'GET /oauth/authorize': 'Initiate OAuth authorization flow',
                'GET /oauth/callback': 'OAuth authorization callback',
                'POST /oauth/refresh': 'Refresh access tokens'
            },
            mcpCapabilities: {
                tools: 'Dynamic CRUD operations for all discovered SAP entities',
                resources: 'Service metadata and entity information',
                logging: 'Comprehensive logging support'
            },
            usage: {
                exampleQueries: [
                    '"Find all sales-related services"',
                    '"Show me what entities are available in the flight booking service"',
                    '"Read the top 10 customers from the business partner service"',
                    '"Create a new travel booking with passenger details"',
                    '"Update the status of order 12345 to completed"',
                    '"Delete the cancelled reservation with ID 67890"'
                ],
                workflowSteps: [
                    'Authentication: Get OAuth token via browser or API',
                    'Discovery: Search services and explore entities',
                    'Execution: Perform CRUD operations with user context',
                    'Monitoring: Check logs and session status'
                ],
                authentication: 'OAuth 2.0 with SAP XSUAA - JWT tokens required for data operations',
                sessionManagement: 'Automatic session creation with user token context'
            }
        });
    });

    // Service discovery configuration endpoints
    app.get('/config/services', (req, res) => {
        try {
            const configSummary = serviceConfigService.getConfigurationSummary();
            res.json(configSummary);
        } catch (error) {
            logger.error('Failed to get service configuration:', error);
            res.status(500).json({ error: 'Failed to get service configuration' });
        }
    });

    // Test service patterns endpoint
    app.post('/config/services/test', (req, res) => {
        try {
            const { serviceNames } = req.body;

            if (!Array.isArray(serviceNames)) {
                return res.status(400).json({ error: 'serviceNames must be an array of strings' });
            }

            const testResult = serviceConfigService.testPatterns(serviceNames);
            res.json(testResult);
        } catch (error) {
            logger.error('Failed to test service patterns:', error);
            res.status(500).json({ error: 'Failed to test service patterns' });
        }
    });

    // Update service configuration endpoint
    app.post('/config/services/update', (req, res) => {
        try {
            const newConfig = req.body;
            serviceConfigService.updateConfiguration(newConfig);

            const updatedConfig = serviceConfigService.getConfigurationSummary();
            res.json({
                message: 'Configuration updated successfully',
                configuration: updatedConfig
            });
        } catch (error) {
            logger.error('Failed to update service configuration:', error);
            res.status(500).json({ error: 'Failed to update service configuration' });
        }
    });
    // Handle 404s
    app.use((req, res) => {
        logger.warn(`❌ 404 - Not found: ${req.method} ${req.path}`);
        res.status(404).json({
            error: 'Not Found',
            message: `The requested endpoint ${req.method} ${req.path} was not found`,
            availableEndpoints: ['/health', '/mcp', '/docs']
        });
    });

    // Global error handler
    app.use((error: Error, req: express.Request, res: express.Response) => {
        logger.error('❌ Unhandled error:', error);

        if (!res.headersSent) {
            res.status(500).json({
                error: 'Internal Server Error',
                message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
            });
        }
    });

    // Clean up expired sessions every hour
    setInterval(cleanupExpiredSessions, 60 * 60 * 1000);

    return app;
}

/**
 * Start the server
 */
export async function startServer(port: number = 3000): Promise<void> {
    const app = createApp();

    return new Promise((resolve, reject) => {
        try {
            const server = app.listen(port, async () => {
                logger.info(`🚀 SAP MCP Server running at http://localhost:${port}`);
                logger.info(`📊 Health check: http://localhost:${port}/health`);
                logger.info(`📚 API docs: http://localhost:${port}/docs`);
                logger.info(`🔧 MCP endpoint: http://localhost:${port}/mcp`);

                logger.info('🚀 Initializing Modern SAP MCP Server...');

                // Initialize destination service
                await destinationService.initialize();

                // Discover SAP OData services
                logger.info('🔍 Discovering SAP OData services...');
                discoveredServices = await sapDiscoveryService.discoverAllServices();

                logger.info(`✅ Discovered ${discoveredServices.length} OData services`);
                resolve();
            });

            server.on('error', (error) => {
                logger.error(`❌ Server error:`, error);
                reject(error);
            });

            // Graceful shutdown
            process.on('SIGTERM', () => {
                logger.info('🛑 SIGTERM received, shutting down gracefully...');

                // Close all sessions
                for (const [sessionId, session] of sessions.entries()) {
                    logger.info(`🔌 Closing session: ${sessionId}`);
                    session.transport.close();
                }
                sessions.clear();

                server.close(() => {
                    logger.info('✅ Server shut down successfully');
                    process.exit(0);
                });
            });

        } catch (error) {
            logger.error(`❌ Failed to start server:`, error);
            reject(error);
        }
    });
}

// Start server if this file is run directly
const port = parseInt(process.env.PORT || '3000');
startServer(port).catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
