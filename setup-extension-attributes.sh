#!/bin/bash

# ============================================================================
# Setup Extension Attributes for Entra ID (Mac/Linux)
# ============================================================================
# This script creates extension attributes for SAP credentials and configures
# them for a test user using Azure CLI.
#
# Prerequisites:
# - Azure CLI installed (brew install azure-cli)
# - Global Admin or Application Admin role
# ============================================================================

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
NC='\033[0m' # No Color

echo -e "${CYAN}============================================================================${NC}"
echo -e "${CYAN}  Entra ID Extension Attributes Setup for SAP Credentials${NC}"
echo -e "${CYAN}============================================================================${NC}"
echo ""

# Check if Azure CLI is installed
if ! command -v az &> /dev/null; then
    echo -e "${RED}✗ Azure CLI is not installed${NC}"
    echo -e "${YELLOW}Install it with: brew install azure-cli${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Azure CLI is installed${NC}"

# Prompt for required information
echo ""
echo -e "${CYAN}Please provide the following information:${NC}"
echo ""

read -p "$(echo -e ${YELLOW}Enter your App CLIENT ID ${GRAY}(from Azure Portal > App registrations > Overview)${NC}: )" CLIENT_ID
read -p "$(echo -e ${YELLOW}Enter test user email ${GRAY}(e.g., s4odata@zeis.de)${NC}: )" USER_EMAIL
read -p "$(echo -e ${YELLOW}Enter SAP username ${GRAY}(e.g., MARIAN)${NC}: )" SAP_USERNAME
read -sp "$(echo -e ${YELLOW}Enter SAP password${NC}: )" SAP_PASSWORD
echo ""
echo ""

# Login check
echo -e "${YELLOW}Checking Azure login status...${NC}"
if ! az account show &> /dev/null; then
    echo -e "${YELLOW}Not logged in. Opening browser for authentication...${NC}"
    az login
else
    echo -e "${GREEN}✓ Already logged in${NC}"
fi

# Get App Object ID
echo ""
echo -e "${GREEN}Step 1: Getting application Object ID...${NC}"
APP_OBJECT_ID=$(az ad app show --id "$CLIENT_ID" --query id -o tsv 2>/dev/null)

if [ -z "$APP_OBJECT_ID" ]; then
    echo -e "${RED}✗ Could not find application with Client ID: $CLIENT_ID${NC}"
    echo -e "${RED}  Please check the Client ID in Azure Portal${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Found application${NC}"
echo -e "${GRAY}  Client ID: $CLIENT_ID${NC}"
echo -e "${GRAY}  Object ID: $APP_OBJECT_ID${NC}"

# Check existing extension properties
echo ""
echo -e "${GREEN}Step 2: Checking existing extension properties...${NC}"

EXISTING_EXTENSIONS=$(az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID/extensionProperties" \
  --query "value[?contains(name, 'SAP')].name" -o tsv 2>/dev/null || echo "")

if echo "$EXISTING_EXTENSIONS" | grep -q "SAPUsername"; then
    echo -e "${YELLOW}  ⚠ SAPUsername extension already exists${NC}"
    CREATE_USERNAME=false
else
    CREATE_USERNAME=true
fi

if echo "$EXISTING_EXTENSIONS" | grep -q "SAPPassword"; then
    echo -e "${YELLOW}  ⚠ SAPPassword extension already exists${NC}"
    CREATE_PASSWORD=false
else
    CREATE_PASSWORD=true
fi

# Create extension attributes
if [ "$CREATE_USERNAME" = true ]; then
    echo -e "${YELLOW}  Creating SAPUsername extension...${NC}"
    az rest --method POST \
      --uri "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID/extensionProperties" \
      --headers "Content-Type=application/json" \
      --body '{
        "name": "SAPUsername",
        "dataType": "String",
        "targetObjects": ["User"]
      }' > /dev/null
    echo -e "${GREEN}  ✓ Created SAPUsername extension${NC}"
fi

if [ "$CREATE_PASSWORD" = true ]; then
    echo -e "${YELLOW}  Creating SAPPassword extension...${NC}"
    az rest --method POST \
      --uri "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID/extensionProperties" \
      --headers "Content-Type=application/json" \
      --body '{
        "name": "SAPPassword",
        "dataType": "String",
        "targetObjects": ["User"]
      }' > /dev/null
    echo -e "${GREEN}  ✓ Created SAPPassword extension${NC}"
fi

# Get full extension property names
echo ""
echo -e "${GREEN}Step 3: Getting extension property names...${NC}"

EXTENSIONS=$(az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID/extensionProperties" \
  --query "value[?contains(name, 'SAP')]" -o json)

USERNAME_ATTR=$(echo "$EXTENSIONS" | jq -r '.[] | select(.name | contains("SAPUsername")) | .name')
PASSWORD_ATTR=$(echo "$EXTENSIONS" | jq -r '.[] | select(.name | contains("SAPPassword")) | .name')

echo -e "${GREEN}  ✓ Username attribute: ${CYAN}$USERNAME_ATTR${NC}"
echo -e "${GREEN}  ✓ Password attribute: ${CYAN}$PASSWORD_ATTR${NC}"

# Get user Object ID
echo ""
echo -e "${GREEN}Step 4: Setting attributes for user...${NC}"

USER_OBJECT_ID=$(az ad user show --id "$USER_EMAIL" --query id -o tsv 2>/dev/null)

if [ -z "$USER_OBJECT_ID" ]; then
    echo -e "${RED}✗ Could not find user: $USER_EMAIL${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Found user: $USER_EMAIL${NC}"
echo -e "${GRAY}  Object ID: $USER_OBJECT_ID${NC}"

# Set user attributes
echo -e "${YELLOW}  Setting SAP credentials...${NC}"

az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/users/$USER_OBJECT_ID" \
  --headers "Content-Type=application/json" \
  --body "{
    \"$USERNAME_ATTR\": \"$SAP_USERNAME\",
    \"$PASSWORD_ATTR\": \"$SAP_PASSWORD\"
  }" > /dev/null

echo -e "${GREEN}✓ User attributes set successfully!${NC}"

# Calculate claim names
CLIENT_ID_NO_HYPHENS=$(echo "$CLIENT_ID" | tr -d '-')
USERNAME_CLAIM="extension_${CLIENT_ID_NO_HYPHENS}_SAPUsername"
PASSWORD_CLAIM="extension_${CLIENT_ID_NO_HYPHENS}_SAPPassword"

# Display summary
echo ""
echo -e "${CYAN}============================================================================${NC}"
echo -e "${CYAN}  Setup Complete! Next Steps:${NC}"
echo -e "${CYAN}============================================================================${NC}"
echo ""
echo -e "${YELLOW}1. Add these claims to your App's Token Configuration:${NC}"
echo ""
echo "   a) Go to Azure Portal > App registrations > Your App > Token configuration"
echo "   b) Click '+ Add optional claim'"
echo "   c) Select 'ID' token type"
echo "   d) Find and check these claims:"
echo "      - extension_SAPUsername"
echo "      - extension_SAPPassword"
echo "   e) Click 'Add'"
echo ""
echo -e "${YELLOW}2. Update your configuration file with these claim names:${NC}"
echo ""
echo -e "   ${CYAN}ENTRA_SAP_USERNAME_CLAIM=\"$USERNAME_CLAIM\"${NC}"
echo -e "   ${CYAN}ENTRA_SAP_PASSWORD_CLAIM=\"$PASSWORD_CLAIM\"${NC}"
echo ""
echo -e "${YELLOW}3. Update your default-env.json or .env file:${NC}"
echo ""
cat << EOF
   {
     "ENTRA_SAP_USERNAME_CLAIM": "$USERNAME_CLAIM",
     "ENTRA_SAP_PASSWORD_CLAIM": "$PASSWORD_CLAIM"
   }
EOF
echo ""
echo -e "${YELLOW}4. Rebuild and restart your application:${NC}"
echo ""
echo "   npm run build && npm start"
echo ""
echo -e "${CYAN}============================================================================${NC}"
echo ""

