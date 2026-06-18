import express from 'express';
import type { RequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import 'dotenv/config';
import {
    setupHttpAuth,
    loadXsuaaCredentials,
    resolveAppUrl,
    type AuthOptions,
    type Logger as AuthLogger,
} from '@arc-mcp/xsuaa-auth';

import { MCPServer, createMCPServer } from './mcp-server.js';
import { Logger } from './utils/logger.js';
import { Config } from './utils/config.js';
import { DestinationService } from './services/destination-service.js';
import { SAPClient } from './services/sap-client.js';
import { SAPDiscoveryService } from './services/sap-discovery.js';
import { ODataService } from './types/sap-types.js';
import { ServiceDiscoveryConfigService } from './services/service-discovery-config.js';

/**
 * Read the validated user JWT that `@arc-mcp/xsuaa-auth`'s bearer middleware
 * places on `req.auth.token` (MCP SDK `AuthInfo`). Used to thread the user
 * identity into per-user OData calls (principal propagation).
 */
function getUserToken(req: express.Request): string | undefined {
    return (req as { auth?: { token?: string } }).auth?.token;
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
let discoveredServices: ODataService[] = [];

/**
 * Thin adapter forwarding the package `Logger` contract `(message, data)` to the
 * repo's winston-backed {@link Logger} (whose methods are `(message, meta?)`).
 */
const authLogger: AuthLogger = {
    debug: (message, data) => logger.debug(message, data),
    info: (message, data) => logger.info(message, data),
    warn: (message, data) => logger.warn(message, data),
    error: (message, data) => logger.error(message, data),
};

/**
 * Wire MCP-native OAuth + the bearer middleware via `@arc-mcp/xsuaa-auth`.
 *
 * Auth-only model: a valid XSUAA token is sufficient (`scopesSupported: []`, no
 * `requiredScopes`); SAP enforces authorization downstream. XSUAA credentials are
 * read from `VCAP_SERVICES` only when present (local/stdio dev has no binding →
 * `bearer` is `undefined` and `/mcp` stays open).
 */
function setupAuth(app: express.Express): RequestHandler | undefined {
    const port = parseInt(process.env.PORT || '3000', 10);
    const appUrl = resolveAppUrl(process.env, { port });

    const options: AuthOptions = {};
    if (process.env.VCAP_SERVICES) {
        try {
            const credentials = loadXsuaaCredentials(process.env);
            options.xsuaa = {
                credentials,
                appUrl,
                scopesSupported: [],
                resourceName: 'btp-sap-odata-to-mcp-server',
            };
        } catch (error) {
            logger.warn(
                `XSUAA binding not available — /mcp will be open (unauthenticated): ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    } else {
        logger.warn('VCAP_SERVICES not set — running without XSUAA OAuth; /mcp is open (local/dev mode).');
    }

    return setupHttpAuth(app, options, authLogger);
}

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

    // Request logging middleware
    app.use((req, res, next) => {
        logger.debug(`📨 ${req.method} ${req.path}`, {
            sessionId: req.headers['mcp-session-id'],
            userAgent: req.headers['user-agent']
        });
        next();
    });

    // MCP-native OAuth proxy + bearer middleware (@arc-mcp/xsuaa-auth).
    // Mounts RFC 8414 discovery + RFC 7591 DCR + /oauth/callback + the SDK auth
    // router (authorize/token/register/revoke). `bearer` guards POST /mcp; when
    // undefined (no XSUAA binding) /mcp stays open for local/dev.
    const bearer = setupAuth(app);
    const requireAuth: RequestHandler = bearer ?? ((_req, _res, next) => next());

    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            activeSessions: sessions.size,
            version: process.env.npm_package_version || '1.0.0'
        });
    });

    // MCP server info endpoint - public (auth optional). When a bearer token is
    // present the upstream router validated it; user info (if any) lives on req.auth.
    app.get('/mcp', (req, res) => {
        const auth = (req as { auth?: { extra?: { userName?: string; email?: string } } }).auth;
        const isAuthenticated = !!auth;
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
                    user: auth?.extra ? {
                        username: auth.extra.userName,
                        email: auth.extra.email,
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

    // Main MCP endpoint - handles all MCP communication.
    // Auth: `requireAuth` is the bearer middleware from @arc-mcp/xsuaa-auth (a
    // no-op pass-through when no XSUAA binding → open for local/dev). It validates
    // the token and places AuthInfo on req.auth; the user JWT (for principal
    // propagation) is read via getUserToken(req) → req.auth.token.
    app.post('/mcp', requireAuth, async (req, res) => {
        const userToken = getUserToken(req);
        try {
            // Get session ID from header
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            let session;

            if (sessionId && sessions.has(sessionId)) {
                // Reuse existing session
                session = await getOrCreateSession(sessionId, userToken);
            } else if (!sessionId && isInitializeRequest(req.body)) {
                // New initialization request with user token if available
                session = await getOrCreateSession(undefined, userToken);
            } else {
                // Invalid request
                logger.warn(`❌ Invalid MCP request - no session ID and not initialize request`);
                return res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: No valid session ID provided or not an initialize request'
                    },
                    id: req.body?.id || null
                });
            }

            // Handle the request
            await session.transport.handleRequest(req, res, req.body);

        } catch (error) {
            logger.error('❌ Error handling MCP request:', error);

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
                'GET /.well-known/oauth-authorization-server': 'OAuth 2.0 Authorization Server Metadata (RFC 8414) — provided by @arc-mcp/xsuaa-auth',
                'GET /.well-known/oauth-protected-resource/mcp': 'OAuth Protected Resource Metadata (RFC 9728)',
                'POST /authorize': 'OAuth 2.0 authorization endpoint (MCP-native OAuth proxy)',
                'POST /token': 'OAuth 2.0 token endpoint',
                'POST /register': 'Dynamic Client Registration (RFC 7591)',
                'GET /oauth/callback': 'OAuth authorization callback proxy'
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
