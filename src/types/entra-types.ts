/**
 * Microsoft Entra ID Authentication Types
 * 
 * Types for Entra ID OAuth 2.0 authentication flow and session management
 */

/**
 * Entra ID Configuration from environment variables
 */
export interface EntraIDConfig {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    authority: string; // Computed: https://login.microsoftonline.com/{tenantId}
    sapUsernameClaimName: string; // Default: extension_SAPUsername
    sapPasswordClaimName: string; // Default: extension_SAPPassword
}

/**
 * Entra ID Token Response from Microsoft
 */
export interface EntraIDTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    refresh_token?: string;
    id_token?: string;
}

/**
 * Decoded ID Token Claims from Entra ID
 */
export interface EntraIDTokenClaims {
    aud: string; // Audience (client ID)
    iss: string; // Issuer
    iat: number; // Issued at
    exp: number; // Expiration time
    sub: string; // Subject (user ID)
    name?: string; // User's display name
    email?: string; // User's email
    preferred_username?: string; // User's preferred username
    oid?: string; // Object ID in Entra ID
    tid?: string; // Tenant ID
    
    // Custom extension attributes for SAP credentials
    [key: string]: string | number | boolean | undefined; // Allow dynamic claim names
}

/**
 * User Session Data stored in memory
 */
export interface EntraIDUserSession {
    sessionId: string;
    entraUserId: string; // Entra ID user object ID
    entraEmail: string; // User's email from Entra ID
    entraDisplayName?: string; // User's display name
    
    // SAP Credentials extracted from Entra ID claims
    sapUsername: string;
    sapPassword: string;
    sapCredentialsValidated: boolean; // Whether SAP credentials have been tested
    
    // Tokens
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    tokenExpiresAt: Date;
    
    // Session metadata
    createdAt: Date;
    lastAccessedAt: Date;
}

/**
 * Authentication mode for the server
 */
export type AuthMode = 'xsuaa' | 'entra' | 'auto';

/**
 * SAP Credential Validation Result
 */
export interface SAPCredentialValidationResult {
    valid: boolean;
    error?: string;
    message?: string;
}

