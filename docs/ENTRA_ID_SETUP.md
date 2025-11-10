# Microsoft Entra ID Setup Guide

This guide walks you through setting up Microsoft Entra ID (formerly Azure AD) authentication for the SAP OData MCP Server, enabling users to authenticate with their Microsoft credentials and access SAP systems with their personal SAP credentials.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Part 1: Azure Portal Setup](#part-1-azure-portal-setup)
3. [Part 2: Configure Custom User Attributes](#part-2-configure-custom-user-attributes)
4. [Part 3: Application Configuration](#part-3-application-configuration)
5. [Part 4: Testing the Setup](#part-4-testing-the-setup)
6. [Part 5: Security Considerations](#part-5-security-considerations)
7. [Troubleshooting](#troubleshooting)

## Prerequisites

- **Azure Subscription** with Microsoft Entra ID (Azure AD)
- **Global Administrator** or **Application Administrator** role in Entra ID
- **SAP System** with OData services enabled
- **Node.js 18+** installed
- **HTTPS-enabled server** or ngrok for local testing

## Part 1: Azure Portal Setup

### Step 1: Register a New Application

1. Navigate to [Azure Portal](https://portal.azure.com)
2. Go to **Microsoft Entra ID** (or **Azure Active Directory**)
3. Select **App registrations** from the left menu
4. Click **+ New registration**

**Application Registration Details:**
- **Name**: `SAP OData MCP Server` (or your preferred name)
- **Supported account types**: 
  - Select **Accounts in this organizational directory only** (Single tenant)
  - Or **Accounts in any organizational directory** (Multi-tenant) if needed
- **Redirect URI**: 
  - Platform: **Web**
  - URI: `https://your-server.com/oauth/entra/callback`
  - For local testing: `http://localhost:3000/oauth/entra/callback`

5. Click **Register**

### Step 2: Note Your Application IDs

After registration, you'll see the **Overview** page. **Copy and save** these values:

- **Application (client) ID**: `12345678-1234-1234-1234-123456789abc`
- **Directory (tenant) ID**: `87654321-4321-4321-4321-cba987654321`

You'll need these for your environment configuration.

### Step 3: Generate Client Secret

1. In your app registration, go to **Certificates & secrets**
2. Click **+ New client secret**
3. **Description**: `MCP Server Secret`
4. **Expires**: Choose appropriate expiration (e.g., 24 months)
5. Click **Add**
6. **IMPORTANT**: Copy the **Value** immediately (it won't be shown again)
   - Example: `abc~123~XyZ...`

### Step 4: Configure API Permissions

1. Go to **API permissions**
2. Click **+ Add a permission**
3. Select **Microsoft Graph**
4. Choose **Delegated permissions**
5. Add the following permissions:
   - `openid` (Sign users in)
   - `profile` (View users' basic profile)
   - `email` (View users' email address)
   - `User.Read` (Sign in and read user profile)
6. Click **Add permissions**
7. Click **Grant admin consent for [Your Organization]** (requires admin)
8. Confirm by clicking **Yes**

### Step 5: Configure Token Configuration

1. Go to **Token configuration**
2. Click **+ Add optional claim**
3. Select **ID** token type
4. Add these claims:
   - `email`
   - `family_name`
   - `given_name`
   - `upn` (User Principal Name)
5. Click **Add**

## Part 2: Configure Custom User Attributes

To store SAP credentials in Entra ID, we need to create custom extension attributes.

### Option A: Using Azure Portal (Recommended for POC)

**Note**: Custom user attributes via Azure Portal require Azure AD Premium P1 or P2.

1. Go to **Microsoft Entra ID** > **Users**
2. Select **User settings**
3. Under **Enterprise applications**, ensure users can consent to apps

### Option B: Using Microsoft Graph API (Programmatic)

For adding extension attributes programmatically, you'll need to use the Microsoft Graph API:

```bash
# Install Microsoft Graph PowerShell (if not already installed)
Install-Module Microsoft.Graph -Scope CurrentUser

# Connect to Microsoft Graph
Connect-MgGraph -Scopes "Application.ReadWrite.All", "Directory.ReadWrite.All"

# Create extension property for SAP Username
$params = @{
    name = "SAPUsername"
    dataType = "String"
    targetObjects = @("User")
}
New-MgApplicationExtensionProperty -ApplicationId <your-app-object-id> -BodyParameter $params

# Create extension property for SAP Password (POC only - not recommended for production)
$params = @{
    name = "SAPPassword"
    dataType = "String"
    targetObjects = @("User")
}
New-MgApplicationExtensionProperty -ApplicationId <your-app-object-id> -BodyParameter $params
```

### Step 6: Set User Attributes

For each user who needs access, set their SAP credentials:

**Using Azure Portal:**
1. Go to **Microsoft Entra ID** > **Users**
2. Select a user
3. Go to **Extensions** (if available) or use Graph API

**Using Microsoft Graph API:**
```powershell
# Set SAP credentials for a user
$userId = "user@domain.com"
$params = @{
    "extension_<app-client-id>_SAPUsername" = "SAP_USER_123"
    "extension_<app-client-id>_SAPPassword" = "encrypted_or_plain_password"
}
Update-MgUser -UserId $userId -BodyParameter $params
```

**Important**: Replace `<app-client-id>` with your application's client ID (without hyphens).

### Step 7: Configure Claims Mapping

To include custom attributes in tokens:

1. Go to your **App registration**
2. Select **Token configuration**
3. Click **+ Add optional claim**
4. Select **ID** token
5. Search for your extension attributes:
   - `extensionSAPUsername`
   - `extensionSAPPassword`
6. Select them and click **Add**

**Alternative: Using App Manifest**

1. Go to **Manifest**
2. Find `"optionalClaims"` section
3. Add:

```json
"optionalClaims": {
  "idToken": [
    {
      "name": "extensionSAPUsername",
      "source": "user",
      "essential": false
    },
    {
      "name": "extensionSAPPassword",
      "source": "user",
      "essential": false
    }
  ]
}
```

4. Click **Save**

## Part 3: Application Configuration

### Environment Variables

Create a `.env` file in your project root:

```env
# Authentication Mode
AUTH_MODE=entra

# Microsoft Entra ID Configuration
ENTRA_TENANT_ID=87654321-4321-4321-4321-cba987654321
ENTRA_CLIENT_ID=12345678-1234-1234-1234-123456789abc
ENTRA_CLIENT_SECRET=abc~123~XyZ...
ENTRA_REDIRECT_URI=https://your-server.com/oauth/entra/callback

# SAP System Configuration
SAP_BASE_URL=https://your-sap-system.com:50001

# Entra ID Claim Names (match your extension attribute names)
ENTRA_SAP_USERNAME_CLAIM=extensionSAPUsername
ENTRA_SAP_PASSWORD_CLAIM=extensionSAPPassword

# Session Configuration
SESSION_SECRET=generate-a-random-secret-here
SESSION_TIMEOUT_MS=3600000

# Server Configuration
PORT=3000
NODE_ENV=production
```

### Generate Session Secret

```bash
# Generate a secure random secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Install Dependencies

```bash
npm install
```

### Build and Start

```bash
npm run build
npm start
```

## Part 4: Testing the Setup

### Test 1: Authentication Flow

1. Open your browser and navigate to:
   ```
   https://your-server.com/oauth/entra/authorize
   ```

2. You should be redirected to Microsoft login page
3. Sign in with your Microsoft credentials
4. Grant consent if prompted
5. You should be redirected back to the callback page with success message

### Test 2: Verify Session

After successful authentication, check your session:

```bash
curl -b cookies.txt https://your-server.com/oauth/entra/userinfo
```

Expected response:
```json
{
  "entraUserId": "...",
  "entraEmail": "user@domain.com",
  "entraDisplayName": "John Doe",
  "sapUsername": "SAP_USER_123",
  "sapCredentialsValidated": false,
  "sessionId": "...",
  "createdAt": "...",
  "tokenExpiresAt": "..."
}
```

### Test 3: MCP Connection

Test the MCP endpoint:

```bash
curl -X POST https://your-server.com/mcp-entra \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": {
        "name": "test-client",
        "version": "1.0.0"
      }
    },
    "id": 1
  }'
```

### Test 4: Verify SAP Credentials

The first MCP operation will validate your SAP credentials. If invalid, you'll receive an error message.

## Part 5: Security Considerations

### ⚠️ POC Limitations

This POC setup has the following limitations:

1. **Passwords in Entra ID**: Storing SAP passwords as plain text in Entra ID attributes is **NOT production-ready**
2. **No Encryption**: Credentials are not encrypted in memory
3. **Session Storage**: In-memory sessions are lost on server restart
4. **HTTPS Required**: Always use HTTPS in production

### Production Recommendations

For production deployments, consider:

1. **Azure Key Vault**: Store SAP credentials in Azure Key Vault
   - Reference credentials by user ID
   - Rotate credentials regularly
   - Audit access

2. **Certificate-Based Auth**: Use X.509 certificates for SAP authentication
   - More secure than passwords
   - Easier to rotate

3. **SAP Cloud Identity Services**: Integrate with SAP IAS
   - Single sign-on to SAP
   - No password storage needed

4. **Credential Encryption**: Encrypt credentials at rest
   - Use AES-256 encryption
   - Store encryption keys securely

5. **Session Management**: Use Redis for session storage
   - Persistent across restarts
   - Supports multiple servers
   - Better performance

## Troubleshooting

### Issue: "Entra ID not configured"

**Solution**: Verify all environment variables are set correctly:
```bash
echo $ENTRA_TENANT_ID
echo $ENTRA_CLIENT_ID
echo $ENTRA_CLIENT_SECRET
echo $ENTRA_REDIRECT_URI
```

### Issue: "SAP credentials not found in token claims"

**Causes**:
1. Extension attributes not created
2. Claims not configured in token
3. User attributes not set

**Solution**:
1. Verify extension attributes exist in App Registration
2. Check Token Configuration includes extension claims
3. Verify user has SAP credentials set
4. Check claim names match environment variables

### Issue: "Redirect URI mismatch"

**Solution**:
1. Ensure redirect URI in Azure matches exactly (including trailing slash)
2. Check ENTRA_REDIRECT_URI environment variable
3. Verify HTTPS vs HTTP

### Issue: "Token validation failed"

**Solution**:
1. Check tenant ID is correct
2. Verify client secret hasn't expired
3. Ensure time synchronization on server

### Issue: "SAP credentials invalid"

**Solution**:
1. Test SAP credentials manually
2. Check SAP system is accessible
3. Verify SAP_BASE_URL is correct
4. Check network connectivity

## Next Steps

- [Deployment Guide](./ENTRA_ID_DEPLOYMENT.md) - Deploy to production
- [SSO Best Practices](./SSO_BEST_PRACTICES.md) - Production-ready authentication
- [README](../README.md) - Main documentation

## Support

For issues or questions:
1. Check the [Troubleshooting](#troubleshooting) section
2. Review Microsoft Entra ID documentation
3. Check server logs for detailed error messages

## References

- [Microsoft Entra ID Documentation](https://learn.microsoft.com/en-us/entra/identity/)
- [MSAL Node.js Documentation](https://github.com/AzureAD/microsoft-authentication-library-for-js/tree/dev/lib/msal-node)
- [Microsoft Graph API](https://learn.microsoft.com/en-us/graph/overview)
- [OAuth 2.0 Authorization Code Flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)

