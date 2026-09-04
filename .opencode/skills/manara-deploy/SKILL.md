---
name: manara-deploy
description: Safe production deployment workflow for Manara on a VPS.
---

# Manara Deployment

Follow this order:

## 1. Inspect

Understand the current project before changing anything.

Identify:
- package.json
- server entry point
- frontend build
- API routes
- database connection
- environment variables
- production scripts

## 2. Validate locally

Run the relevant:

- tests
- build
- lint/type checks when configured

Do not deploy known failing code unless explicitly instructed.

## 3. Git

Before deployment verify:

- correct branch
- clean or understood working tree
- latest intended commit
- no secrets committed

## 4. Server preparation

Verify:

- Linux distribution
- Node.js version
- npm/pnpm/yarn version
- Git
- Nginx
- process manager
- firewall
- available disk
- memory

Do not upgrade system packages blindly.

## 5. Environment

Create production environment configuration.

Never copy development secrets blindly.

Verify required variables exist.

Never print secret values in logs or responses.

## 6. Application

Install production dependencies.

Build the application where required.

Start using a production process manager.

Do not use development servers in production.

## 7. Reverse proxy

Nginx should proxy only the required application endpoints.

Do not expose internal application ports unnecessarily.

## 8. HTTPS

Use HTTPS for production.

Verify:
- certificate
- HTTP → HTTPS redirect
- secure cookies
- correct domain

## 9. Verification

After deployment test:

- homepage
- login
- logout
- authenticated API
- authorization
- database
- uploads
- subscription
- payment flow
- error handling

## 10. Rollback

Before risky deployment, know how to return to the previous working version.

Never delete the previous working release until the new release is verified.