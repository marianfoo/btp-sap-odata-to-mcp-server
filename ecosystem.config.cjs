/**
 * PM2 Ecosystem Configuration for btp-sap-odata-to-mcp-server
 * 
 * This configuration runs the MCP server in production mode with PM2 process manager.
 * 
 * Usage:
 *   - Start: pm2 start ecosystem.config.cjs
 *   - Stop: pm2 stop btp-sap-odata-mcp
 *   - Restart: pm2 restart btp-sap-odata-mcp
 *   - Logs: pm2 logs btp-sap-odata-mcp
 *   - Monitor: pm2 monit
 *   - Status: pm2 status
 * 
 * Important:
 *   - Make sure to set ACCESS_TOKEN in your environment or .env file
 *   - Configure your SAP destination settings before starting
 *   - Check logs with: pm2 logs btp-sap-odata-mcp
 */

module.exports = {
  apps: [
    {
      name: 'btp-sap-odata-mcp',
      script: 'dist/index.js',
      cwd: '/root/btp-sap-odata-to-mcp-server',
      
      // Process management
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      
      // Environment variables (production)
      env: {
        NODE_ENV: 'production',
        PORT: 3144,
        LOG_LEVEL: 'info'
      },
      
      // Environment variables (development)
      env_development: {
        NODE_ENV: 'development',
        PORT: 3144,
        LOG_LEVEL: 'debug'
      },
      
      // Logging configuration
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      
      // Restart strategy - exponential backoff
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '10s',
      
      // Additional settings
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000
    }
  ]
};

/**
 * Configuration Notes:
 * 
 * 1. Working Directory:
 *    Update the 'cwd' field to match your actual installation path
 *    Default: /root/btp-sap-odata-to-mcp-server
 * 
 * 2. Environment Variables:
 *    Configure these in your .env file or set them in PM2:
 *    - ACCESS_TOKEN: Required for bearer token authentication
 *    - SAP_DESTINATION_NAME: Name of SAP destination (default: SAP_SYSTEM)
 *    - destinations: JSON array of destinations for local dev
 *    - LOG_LEVEL: Logging level (debug, info, warn, error)
 *    - DISABLE_READ_ENTITY_TOOL: Set to 'true' to disable ReadEntity tools
 * 
 * 3. Setting Environment Variables with PM2:
 *    pm2 set btp-sap-odata-mcp:ACCESS_TOKEN "your-secret-token-here"
 *    
 * 4. Using .env file:
 *    Make sure your .env file is in the project root with:
 *    ACCESS_TOKEN=your-secret-token-here
 *    PORT=3144
 *    
 * 5. Production Deployment:
 *    pm2 start ecosystem.config.cjs --env production
 *    pm2 save
 *    pm2 startup
 * 
 * 6. Nginx Configuration (example for mcp-sap-s4.marianzeis.de):
 *    server {
 *        listen 443 ssl http2;
 *        server_name mcp-sap-s4.marianzeis.de;
 *        
 *        ssl_certificate /path/to/fullchain.pem;
 *        ssl_certificate_key /path/to/privkey.pem;
 *        
 *        location / {
 *            proxy_pass http://localhost:3144;
 *            proxy_http_version 1.1;
 *            proxy_set_header Upgrade $http_upgrade;
 *            proxy_set_header Connection 'upgrade';
 *            proxy_set_header Host $host;
 *            proxy_cache_bypass $http_upgrade;
 *            proxy_set_header X-Real-IP $remote_addr;
 *            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 *            proxy_set_header X-Forwarded-Proto $scheme;
 *        }
 *    }
 */

