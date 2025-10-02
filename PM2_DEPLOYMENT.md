# 🚀 PM2 Production Deployment Guide

Quick reference for deploying the BTP SAP OData MCP Server with PM2 process manager.

## Prerequisites

- Node.js 18+ installed
- PM2 installed globally: `npm install -g pm2`
- Server access and domain configured

## Quick Start

### 1. Setup on Server

```bash
# Clone repository
cd /root
git clone <your-repo-url> btp-sap-odata-to-mcp-server
cd btp-sap-odata-to-mcp-server

# Install dependencies
npm install

# Build the project
npm run build
```

### 2. Configure Environment

Create `.env` file in project root:

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
```

**Generate a secure token:**
```bash
openssl rand -hex 32
```

### 3. Update PM2 Config

Edit `ecosystem.config.cjs` - change the `cwd` field to your actual path:

```javascript
cwd: '/root/btp-sap-odata-to-mcp-server',
```

### 4. Start with PM2

```bash
# Start the application
npm run pm2:start

# Save PM2 configuration (survives reboots)
pm2 save

# Setup PM2 to start on system boot
pm2 startup
# Follow the command PM2 outputs
```

## PM2 Management Commands

```bash
# Status
npm run pm2:status          # Check application status
pm2 status                  # Alternative

# Logs
npm run pm2:logs           # View logs in real-time
pm2 logs btp-sap-odata-mcp --lines 100

# Control
npm run pm2:restart        # Restart application
npm run pm2:stop           # Stop application
npm run pm2:delete         # Remove from PM2

# Monitoring
npm run pm2:monit          # Monitor CPU/Memory usage
```

## Nginx Reverse Proxy Setup

For domain: `mcp-sap-s4.marianzeis.de`

### 1. Create Nginx Configuration

Create `/etc/nginx/sites-available/mcp-sap-s4`:

```nginx
server {
    listen 443 ssl http2;
    server_name mcp-sap-s4.marianzeis.de;
    
    # SSL certificates (Let's Encrypt)
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
        
        # Timeouts for long-running requests
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

### 2. Enable Site

```bash
# Enable the site
ln -s /etc/nginx/sites-available/mcp-sap-s4 /etc/nginx/sites-enabled/

# Test configuration
nginx -t

# Reload Nginx
systemctl reload nginx
```

### 3. SSL with Let's Encrypt

```bash
# Install certbot
apt install certbot python3-certbot-nginx

# Get certificate
certbot --nginx -d mcp-sap-s4.marianzeis.de

# Auto-renewal is configured automatically
```

## Testing the Deployment

### Health Check

```bash
# Local
curl http://localhost:3144/health

# Via domain
curl https://mcp-sap-s4.marianzeis.de/health
```

### Bearer Token Authentication

```bash
# Generate test token
export TEST_TOKEN="your-access-token-from-env"

# Test without token (should fail - 401)
curl -X POST https://mcp-sap-s4.marianzeis.de/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}'

# Test with valid token (should succeed)
curl -X POST https://mcp-sap-s4.marianzeis.de/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
```

## Troubleshooting

### Check Logs

```bash
# PM2 logs
pm2 logs btp-sap-odata-mcp --lines 100

# PM2 error logs only
pm2 logs btp-sap-odata-mcp --err --lines 50

# Nginx logs
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```

### Common Issues

**Port already in use:**
```bash
lsof -i :3144
# Kill the process or change PORT in .env
```

**PM2 not starting:**
```bash
# Check for build errors
npm run build

# Check PM2 logs
pm2 logs btp-sap-odata-mcp --err
```

**Cannot access via domain:**
```bash
# Check DNS
nslookup mcp-sap-s4.marianzeis.de

# Check Nginx status
systemctl status nginx

# Test Nginx config
nginx -t
```

**Memory issues:**
```bash
# Check current memory usage
pm2 monit

# Increase in ecosystem.config.cjs:
max_memory_restart: '2G'

# Restart
pm2 restart btp-sap-odata-mcp
```

## Updating the Application

```bash
# Pull latest changes
cd /root/btp-sap-odata-to-mcp-server
git pull

# Rebuild
npm install
npm run build

# Restart PM2
npm run pm2:restart

# Check logs for errors
npm run pm2:logs
```

## Maintenance

### Regular Tasks

```bash
# Check PM2 status daily
pm2 status

# Review logs weekly
pm2 logs btp-sap-odata-mcp --lines 500 > review.log

# Update dependencies monthly
npm update
npm run build
pm2 restart btp-sap-odata-mcp
```

### PM2 Resurrection

If PM2 loses track of apps after reboot:

```bash
# Delete current PM2 processes
pm2 delete all

# Start fresh
pm2 start ecosystem.config.cjs

# Save and setup startup
pm2 save
pm2 startup
```

## Security Checklist

- [ ] Strong `ACCESS_TOKEN` generated and set
- [ ] `.env` file has restricted permissions (`chmod 600 .env`)
- [ ] Nginx SSL configured with valid certificates
- [ ] Firewall allows only necessary ports (80, 443)
- [ ] Regular system updates applied
- [ ] PM2 logs rotated (PM2 handles this automatically)
- [ ] SAP credentials secured in environment variables
- [ ] Domain DNS properly configured

## Performance Optimization

### PM2 Configuration

In `ecosystem.config.cjs`:

```javascript
{
  max_memory_restart: '1G',      // Restart if memory exceeds 1GB
  instances: 1,                   // Single instance (increase for load balancing)
  autorestart: true,              // Auto-restart on crashes
  watch: false,                   // Don't watch files in production
  max_restarts: 10,               // Max restart attempts
  min_uptime: '10s'              // Min uptime before considering stable
}
```

### Nginx Optimization

Add to Nginx config:

```nginx
# Enable gzip compression
gzip on;
gzip_types text/plain application/json;

# Connection limits
limit_conn_zone $binary_remote_addr zone=addr:10m;
limit_conn addr 10;
```

## Documentation

For more details, see:
- [LOCAL_RUN.md](docs/LOCAL_RUN.md) - Full local development and deployment guide
- [ecosystem.config.cjs](ecosystem.config.cjs) - PM2 configuration with comments
- [example.env](example.env) - Environment variable examples

## Support

If you encounter issues:
1. Check PM2 logs: `pm2 logs btp-sap-odata-mcp`
2. Check Nginx logs: `tail -f /var/log/nginx/error.log`
3. Test locally: `curl http://localhost:3144/health`
4. Review environment variables in `.env`
5. Verify SAP connectivity and credentials

