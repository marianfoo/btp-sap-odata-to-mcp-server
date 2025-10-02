# Running the MCP Server Locally

You can run the MCP server locally (in VS Code, SAP Business Application Studio, or any environment) using a `default-env.json` file for service credentials. Optionally, you can use a `.env` file to override the destination name.

## 🔐 Bearer Token Authentication

The server supports **bearer token authentication** for securing access. This is a simple but effective way to protect your MCP server when deployed.

### Setup Bearer Token

Add to your `.env` file:

```env
ACCESS_TOKEN=your-secret-token-here
PORT=3144
```

If `ACCESS_TOKEN` is set, all requests to the `/mcp` endpoint **must** include a valid Authorization header:

```
Authorization: Bearer your-secret-token-here
```

The server also supports a non-standard `bearer` header for compatibility with Microsoft Power Platform and other proxies.

**Security Notes:**
- If `ACCESS_TOKEN` is **not set**, the server runs **WITHOUT** bearer token authentication
- Use a strong, randomly generated token (e.g., 32+ character hex string)
- Keep your token secret - treat it like a password
- Generate a token: `openssl rand -hex 32`

## Configuration Steps

1. Copy `example-default-env.json` to `default-env.json` in your project root.
2. Fill in the placeholders with the credentials for your:
   - **Destination service instance**
   - **Connectivity service instance**
   - **XSUAA service instance** (currently not used, but planned for future authentication support)

## Optional: Override Destination Name with .env

If you want to use a different destination than `SAP_SYSTEM`, create a `.env` file in your project root and set:

```env
SAP_DESTINATION_NAME=MY_DESTINATION
```

You can also set any service discovery environment variables described in the main documentation.

## Run Locally Without BTP (env destinations)

You can run fully locally without BTP Destination/Connectivity by providing a destination via environment variables. Your machine must be able to reach the SAP host/port directly (VPN as needed); Cloud Connector is not used in this mode.

### Option A: .env (recommended)
```env
SAP_DESTINATION_NAME=S4
destinations=[{"name":"S4","url":"https://<URL>:<PORT>","username":"<USER>","password":"<PASSWORD>"}]
# If your system uses self-signed TLS certificates (local only):
# NODE_TLS_REJECT_UNAUTHORIZED=0
# Optional logging:
# LOG_LEVEL=debug
```

### Option B: one-off in your shell
```bash
export SAP_DESTINATION_NAME=S4
export destinations='[{"name":"S4","url":"https://<host>:<port>","username":"<user>","password":"<pass>"}]'
# If needed for self-signed TLS:
# export NODE_TLS_REJECT_UNAUTHORIZED=0
```

Notes:
- The default destination name is `SAP_SYSTEM`. Either set `SAP_DESTINATION_NAME` or make the JSON `name` match `SAP_SYSTEM`.
- The server accepts `destinations` or `DESTINATIONS`. If exactly one destination is provided, it will be used automatically.
- If XSUAA is not configured in VCAP (local), OAuth is disabled and the server runs without a token requirement.

Verify after start:
- Health: `http://localhost:3000/health`
- MCP info: `http://localhost:3000/mcp`

Troubleshooting:
- If you see messages about missing destination service bindings, ensure `destinations`/`DESTINATIONS` is set in your environment or `.env`.
```

## Running the Server

After configuration, start the server with:

```bash
npm run start:http
```


## ⚙️ Environment Variable: Disable ReadEntity Tool Registration

To disable registration of the ReadEntity tool for all entities in all services, set the following in your `.env` file:

```env
DISABLE_READ_ENTITY_TOOL=true
```
This will prevent registration of the ReadEntity tool for all entities and services.

- The XSUAA configuration is present for future authentication support, but is not currently used.
- You can combine these environment variables with any service discovery configuration described in `SERVICE_DISCOVERY_CONFIG.md`.
- For more advanced configuration, see the main documentation.

---

## 🚀 Production Deployment with PM2

PM2 is a production process manager for Node.js applications. Use it to keep your MCP server running continuously, with automatic restarts and monitoring.

### Prerequisites

1. Install PM2 globally (or use the devDependency):
   ```bash
   npm install -g pm2
   # or use local: npx pm2
   ```

2. Build the application:
   ```bash
   npm run build
   ```

### Quick Start with PM2

1. **Update the ecosystem config** (`ecosystem.config.cjs`):
   - Change the `cwd` field to your actual installation path
   - Default: `/root/btp-sap-odata-to-mcp-server`

2. **Create your `.env` file** with required configuration:
   ```env
   # Required: Bearer token authentication
   ACCESS_TOKEN=your-secret-token-here
   
   # Server configuration
   PORT=3144
   NODE_ENV=production
   LOG_LEVEL=info
   
   # SAP Configuration
   SAP_DESTINATION_NAME=SAP_SYSTEM
   destinations=[{"name":"SAP_SYSTEM","url":"https://<host>:<port>","username":"<user>","password":"<pass>"}]
   
   # Optional: Disable ReadEntity tool registration
   # DISABLE_READ_ENTITY_TOOL=true
   ```

3. **Start the server with PM2**:
   ```bash
   # Using npm script
   npm run pm2:start
   
   # Or directly with PM2
   pm2 start ecosystem.config.cjs
   ```

4. **Save PM2 configuration** (persists after reboot):
   ```bash
   pm2 save
   pm2 startup
   # Follow the instructions PM2 provides
   ```

### PM2 Management Commands

```bash
# View logs (real-time)
npm run pm2:logs
# or: pm2 logs btp-sap-odata-mcp

# Check status
npm run pm2:status
# or: pm2 status

# Restart the server
npm run pm2:restart
# or: pm2 restart btp-sap-odata-mcp

# Stop the server
npm run pm2:stop
# or: pm2 stop btp-sap-odata-mcp

# Monitor resource usage
npm run pm2:monit
# or: pm2 monit

# Remove from PM2
npm run pm2:delete
# or: pm2 delete btp-sap-odata-mcp
```

### Deploying to a Remote Server

Example for domain `mcp-sap-s4.marianzeis.de`:

1. **On your server**, clone and setup:
   ```bash
   cd /root
   git clone <your-repo> btp-sap-odata-to-mcp-server
   cd btp-sap-odata-to-mcp-server
   npm install
   ```

2. **Configure environment**:
   ```bash
   # Create .env file
   nano .env
   
   # Add your configuration:
   ACCESS_TOKEN=$(openssl rand -hex 32)
   PORT=3144
   NODE_ENV=production
   LOG_LEVEL=info
   # ... add SAP configuration
   ```

3. **Update PM2 config path** in `ecosystem.config.cjs`:
   ```javascript
   cwd: '/root/btp-sap-odata-to-mcp-server',
   ```

4. **Build and start**:
   ```bash
   npm run build
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup
   ```

5. **Setup Nginx reverse proxy** (for HTTPS):

   Create `/etc/nginx/sites-available/mcp-sap-s4`:
   ```nginx
   server {
       listen 443 ssl http2;
       server_name mcp-sap-s4.marianzeis.de;
       
       # SSL certificates (use Let's Encrypt certbot)
       ssl_certificate /etc/letsencrypt/live/mcp-sap-s4.marianzeis.de/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/mcp-sap-s4.marianzeis.de/privkey.pem;
       
       # SSL configuration
       ssl_protocols TLSv1.2 TLSv1.3;
       ssl_prefer_server_ciphers on;
       ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
       
       location / {
           proxy_pass http://localhost:3144;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           
           # Increase timeouts for long-running requests
           proxy_connect_timeout 60s;
           proxy_send_timeout 60s;
           proxy_read_timeout 60s;
       }
   }
   
   # Redirect HTTP to HTTPS
   server {
       listen 80;
       server_name mcp-sap-s4.marianzeis.de;
       return 301 https://$server_name$request_uri;
   }
   ```

6. **Enable Nginx site**:
   ```bash
   ln -s /etc/nginx/sites-available/mcp-sap-s4 /etc/nginx/sites-enabled/
   nginx -t
   systemctl reload nginx
   ```

7. **Setup SSL with Let's Encrypt** (if not done):
   ```bash
   apt install certbot python3-certbot-nginx
   certbot --nginx -d mcp-sap-s4.marianzeis.de
   ```

8. **Verify deployment**:
   ```bash
   # Check PM2 status
   pm2 status
   
   # Check logs
   pm2 logs btp-sap-odata-mcp --lines 50
   
   # Test locally
   curl http://localhost:3144/health
   
   # Test via domain
   curl https://mcp-sap-s4.marianzeis.de/health
   ```

### Testing Bearer Token Authentication

```bash
# Generate a test token
export TEST_TOKEN=$(openssl rand -hex 32)
echo "Token: $TEST_TOKEN"

# Test without token (should fail with 401)
curl -X POST https://mcp-sap-s4.marianzeis.de/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}'

# Test with valid token (should succeed)
curl -X POST https://mcp-sap-s4.marianzeis.de/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
```

### Monitoring and Maintenance

```bash
# Real-time logs
pm2 logs btp-sap-odata-mcp

# Resource monitoring
pm2 monit

# Check if server is responding
curl https://mcp-sap-s4.marianzeis.de/health

# Restart after config changes
pm2 restart btp-sap-odata-mcp

# View PM2 startup script
pm2 startup

# Ensure PM2 resurrects on reboot
pm2 save
```

### Troubleshooting PM2 Deployment

1. **Server not starting:**
   ```bash
   pm2 logs btp-sap-odata-mcp --err --lines 50
   npm run build  # Rebuild if needed
   ```

2. **Port already in use:**
   ```bash
   lsof -i :3144
   # Kill process or change PORT in .env
   ```

3. **Environment variables not loading:**
   ```bash
   # Check if .env is in the correct location
   ls -la /root/btp-sap-odata-to-mcp-server/.env
   # Verify dotenv is loading (check logs)
   pm2 logs btp-sap-odata-mcp | grep ACCESS_TOKEN
   ```

4. **Memory issues:**
   ```bash
   # Increase max memory in ecosystem.config.cjs
   max_memory_restart: '2G',  # Default is 1G
   ```

5. **Can't access via domain:**
   ```bash
   # Check Nginx is running
   systemctl status nginx
   
   # Check Nginx error logs
   tail -f /var/log/nginx/error.log
   
   # Verify DNS points to your server
   nslookup mcp-sap-s4.marianzeis.de
   ```

---
