# ============================================================================
# Setup Extension Attributes for Entra ID
# ============================================================================
# This script creates extension attributes for SAP credentials and configures
# them for a test user.
#
# Prerequisites:
# - PowerShell 7+
# - Microsoft.Graph PowerShell module
# - Global Admin or Application Admin role
# ============================================================================

param(
    [Parameter(Mandatory=$true)]
    [string]$AppObjectId,
    
    [Parameter(Mandatory=$true)]
    [string]$TestUserEmail,
    
    [Parameter(Mandatory=$true)]
    [string]$SAPUsername,
    
    [Parameter(Mandatory=$true)]
    [string]$SAPPassword
)

Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "  Entra ID Extension Attributes Setup for SAP Credentials" -ForegroundColor Cyan
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""

# Check if Microsoft.Graph module is installed
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph)) {
    Write-Host "Installing Microsoft.Graph module..." -ForegroundColor Yellow
    Install-Module Microsoft.Graph -Scope CurrentUser -Force
}

# Import required modules
Import-Module Microsoft.Graph.Applications
Import-Module Microsoft.Graph.Users

# Connect to Microsoft Graph
Write-Host "Connecting to Microsoft Graph..." -ForegroundColor Yellow
Connect-MgGraph -Scopes "Application.ReadWrite.All", "User.ReadWrite.All" -NoWelcome

# Verify app exists
Write-Host ""
Write-Host "Step 1: Verifying application..." -ForegroundColor Green
try {
    $app = Get-MgApplication -ApplicationId $AppObjectId -ErrorAction Stop
    Write-Host "✓ Found application: $($app.DisplayName)" -ForegroundColor Green
    Write-Host "  Client ID: $($app.AppId)" -ForegroundColor Gray
} catch {
    Write-Host "✗ Application not found with Object ID: $AppObjectId" -ForegroundColor Red
    Write-Host "  Please check the Object ID in Azure Portal > App registrations > Your App > Overview" -ForegroundColor Red
    exit 1
}

# Check if extension properties already exist
Write-Host ""
Write-Host "Step 2: Checking existing extension properties..." -ForegroundColor Green
$existingExtensions = Get-MgApplicationExtensionProperty -ApplicationId $AppObjectId

$usernameExt = $existingExtensions | Where-Object { $_.Name -like "*SAPUsername" }
$passwordExt = $existingExtensions | Where-Object { $_.Name -like "*SAPPassword" }

# Create SAPUsername extension if it doesn't exist
if ($usernameExt) {
    Write-Host "✓ SAPUsername extension already exists: $($usernameExt.Name)" -ForegroundColor Yellow
    $usernameAttrName = $usernameExt.Name
} else {
    Write-Host "Creating SAPUsername extension attribute..." -ForegroundColor Yellow
    $usernameParams = @{
        name = "SAPUsername"
        dataType = "String"
        targetObjects = @("User")
    }
    $usernameExt = New-MgApplicationExtensionProperty -ApplicationId $AppObjectId -BodyParameter $usernameParams
    $usernameAttrName = $usernameExt.Name
    Write-Host "✓ Created: $usernameAttrName" -ForegroundColor Green
}

# Create SAPPassword extension if it doesn't exist
if ($passwordExt) {
    Write-Host "✓ SAPPassword extension already exists: $($passwordExt.Name)" -ForegroundColor Yellow
    $passwordAttrName = $passwordExt.Name
} else {
    Write-Host "Creating SAPPassword extension attribute..." -ForegroundColor Yellow
    $passwordParams = @{
        name = "SAPPassword"
        dataType = "String"
        targetObjects = @("User")
    }
    $passwordExt = New-MgApplicationExtensionProperty -ApplicationId $AppObjectId -BodyParameter $passwordParams
    $passwordAttrName = $passwordExt.Name
    Write-Host "✓ Created: $passwordAttrName" -ForegroundColor Green
}

# Set attributes for test user
Write-Host ""
Write-Host "Step 3: Setting attributes for test user..." -ForegroundColor Green
try {
    $user = Get-MgUser -UserId $TestUserEmail -ErrorAction Stop
    Write-Host "✓ Found user: $($user.DisplayName) ($($user.UserPrincipalName))" -ForegroundColor Green
    
    # Update user with extension attributes
    $updateParams = @{
        $usernameAttrName = $SAPUsername
        $passwordAttrName = $SAPPassword
    }
    
    Update-MgUser -UserId $user.Id -BodyParameter $updateParams
    Write-Host "✓ User attributes updated successfully!" -ForegroundColor Green
} catch {
    Write-Host "✗ Failed to update user: $_" -ForegroundColor Red
    exit 1
}

# Calculate claim names for token configuration
$clientId = $app.AppId -replace '-', ''
$usernameClaimName = "extension_${clientId}_SAPUsername"
$passwordClaimName = "extension_${clientId}_SAPPassword"

# Display summary
Write-Host ""
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "  Setup Complete! Next Steps:" -ForegroundColor Cyan
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Add these claims to your App's Token Configuration:" -ForegroundColor Yellow
Write-Host ""
Write-Host "   a) Go to Azure Portal > App registrations > Your App > Token configuration"
Write-Host "   b) Click '+ Add optional claim'"
Write-Host "   c) Select 'ID' token type"
Write-Host "   d) Find and check these claims:"
Write-Host "      - extension_SAPUsername"
Write-Host "      - extension_SAPPassword"
Write-Host "   e) Click 'Add'"
Write-Host ""
Write-Host "2. Update your configuration file with these claim names:" -ForegroundColor Yellow
Write-Host ""
Write-Host "   ENTRA_SAP_USERNAME_CLAIM=$usernameClaimName" -ForegroundColor Cyan
Write-Host "   ENTRA_SAP_PASSWORD_CLAIM=$passwordClaimName" -ForegroundColor Cyan
Write-Host ""
Write-Host "3. Rebuild and restart your application:" -ForegroundColor Yellow
Write-Host ""
Write-Host "   npm run build && npm start"
Write-Host ""
Write-Host "============================================================================" -ForegroundColor Cyan

# Disconnect
Disconnect-MgGraph | Out-Null
Write-Host "Disconnected from Microsoft Graph" -ForegroundColor Gray
Write-Host ""

