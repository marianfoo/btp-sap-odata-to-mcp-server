# Local Testing with Entra ID

Quick guide to test Entra ID authentication on your local machine without deploying to a server.

## Prerequisites

- ✅ Node.js 18+ installed
- ✅ Azure Portal access (to configure Entra ID)
- ✅ SAP system accessible from your machine
- ✅ ngrok installed (recommended) or localhost configuration

## Quick Start (5 minutes)

### Step 1: Configure Azure Portal

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to **Microsoft Entra ID** > **App registrations**
3. Select your app (or create new one)
4. Go to **Authentication** > **Add a platform** > **Web**
5. Add redirect URI:
   - For ngrok: `https://YOUR-NGROK-URL.ngrok.io/oauth/entra/callback` (you'll get this in Step 3)
   - For localhost: `http://localhost:3000/oauth/entra/callback`
6. Save

### Step 2: Set Environment Variables

Create a `.env` file in the project root:

```env
AUTH_MODE=entra
ENTRA_TENANT_ID=your-tenant-id
ENTRA_CLIENT_ID=your-client-id
ENTRA_CLIENT_SECRET=your-client-secret
ENTRA_REDIRECT_URI=http://localhost:3000/oauth/entra/callback
ENTRA_SAP_USERNAME_CLAIM=extensionSAPUsername
ENTRA_SAP_PASSWORD_CLAIM=extensionSAPPassword
SAP_BASE_URL=https://a4h.computerservice-wolf.com:50001
SESSION_SECRET=local-test-secret
NODE_ENV=development
LOG_LEVEL=debug
```

**Get your credentials from Azure Portal:**
- Tenant ID: App registration > Overview > Directory (tenant) ID
- Client ID: App registration > Overview > Application (client) ID
- Client Secret: App registration > Certificates & secrets > New client secret

### Step 3: Start the Server

#### Option A: Using ngrok (Recommended)

**Terminal 1 - Start MCP Server:**
```bash
cd /Users/marianzeis/.cursor/worktrees/btp-sap-odata-to-mcp-server/CXwMs
npm install
npm run build
npm start
```

**Terminal 2 - Start ngrok:**
```bash
ngrok http 3000
```

Copy the ngrok URL (e.g., `https://abc123.ngrok.io`) and:
1. Update `.env`: `ENTRA_REDIRECT_URI=https://abc123.ngrok.io/oauth/entra/callback`
2. Update Azure Portal redirect URI to match
3. Restart the MCP server

**Test:**
```bash
# Open in browser
open https://abc123.ngrok.io/oauth/entra/authorize
```

#### Option B: Using localhost

**Terminal:**
```bash
cd /Users/marianzeis/.cursor/worktrees/btp-sap-odata-to-mcp-server/CXwMs
npm install
npm run build
npm start
```

**Test:**
```bash
# Open in browser
open http://localhost:3000/oauth/entra/authorize
```

### Step 4: Test Authentication Flow

1. Browser opens Microsoft login page
2. Sign in with your Microsoft credentials
3. Grant consent (first time only)
4. You'll be redirected back with success message
5. Your session is now active!

### Step 5: Verify Session

**Check user info:**
```bash
# Get session cookie from browser or use curl with cookie jar
curl http://localhost:3000/oauth/entra/userinfo \
  -H "Cookie: entra_session_id=YOUR_SESSION_ID"
```

**Expected response:**
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

## Testing MCP Operations

Once authenticated, you can test MCP operations:

```bash
# Test MCP endpoint (requires session cookie)
curl -X POST http://localhost:3000/mcp-entra \
  -H "Content-Type: application/json" \
  -H "Cookie: entra_session_id=YOUR_SESSION_ID" \
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

## Useful Endpoints for Testing

| Endpoint | Description | Auth Required |
|----------|-------------|---------------|
| `/health` | Server health check | No |
| `/oauth/entra/authorize` | Start OAuth flow | No |
| `/oauth/entra/callback` | OAuth callback (automatic) | No |
| `/oauth/entra/userinfo` | Get current user info | Yes (cookie) |
| `/oauth/entra/stats` | Session statistics | No |
| `/oauth/entra/logout` | Logout (POST) | Yes (cookie) |
| `/mcp-entra` | MCP endpoint | Yes (cookie) |

## Troubleshooting

### Issue: "Entra ID not configured"

**Check environment variables:**
```bash
# In your terminal where server runs
echo $ENTRA_TENANT_ID
echo $ENTRA_CLIENT_ID
echo $ENTRA_CLIENT_SECRET
```

**Solution:** Ensure all variables are set in `.env` file

### Issue: "Redirect URI mismatch"

**Solution:**
1. Check Azure Portal redirect URI matches exactly
2. Check `.env` ENTRA_REDIRECT_URI matches
3. Restart server after changes

### Issue: "SAP credentials not found in token claims"

**Cause:** Custom attributes not configured in Entra ID

**Solution:**
1. Follow [ENTRA_ID_SETUP.md](./ENTRA_ID_SETUP.md) to create extension attributes
2. Verify token configuration includes custom claims
3. Check user has SAP credentials set

### Issue: ngrok URL changes every restart

**Solution:** 
- Free ngrok URLs change on restart
- Upgrade to ngrok paid plan for static URLs
- Or use localhost for testing (less secure)

### Issue: "Cannot connect to SAP system"

**Check:**
```bash
# Test SAP connectivity
curl -k https://a4h.computerservice-wolf.com:50001/sap/opu/odata/sap/
```

**Solution:**
- Ensure SAP system is accessible from your machine
- Check VPN connection if required
- Verify SAP_BASE_URL in `.env`

## Advanced: Testing with Multiple Users

1. Configure SAP credentials for multiple users in Entra ID
2. Open browser in incognito/private mode for each user
3. Each user gets their own session
4. Test concurrent access

## Next Steps

- ✅ Local testing working? → Deploy to your server
- ✅ Ready for production? → Review [SSO_BEST_PRACTICES.md](./SSO_BEST_PRACTICES.md)
- ✅ Need help? → Check [ENTRA_ID_SETUP.md](./ENTRA_ID_SETUP.md)

## Quick Commands Reference

```bash
# Install and build
npm install && npm run build

# Start server
npm start

# Start with ngrok
ngrok http 3000

# Check logs
tail -f logs/app.log  # if logging to file

# Test health
curl http://localhost:3000/health

# Generate session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Environment Variables Checklist

Before starting, ensure you have:

- [ ] `AUTH_MODE=entra`
- [ ] `ENTRA_TENANT_ID` (from Azure Portal)
- [ ] `ENTRA_CLIENT_ID` (from Azure Portal)
- [ ] `ENTRA_CLIENT_SECRET` (from Azure Portal)
- [ ] `ENTRA_REDIRECT_URI` (matches Azure Portal)
- [ ] `SAP_BASE_URL` (your SAP system)
- [ ] `SESSION_SECRET` (any random string for testing)

## Success Indicators

✅ Server starts without errors  
✅ `/health` endpoint returns 200  
✅ `/oauth/entra/authorize` redirects to Microsoft login  
✅ After login, redirected back with success message  
✅ `/oauth/entra/userinfo` returns your user data  
✅ Session cookie is set in browser  

Happy testing! 🚀

