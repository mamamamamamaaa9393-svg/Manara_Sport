---
name: manara-production
description: Production readiness review for the Manara application.
---

# Manara Production Review

Review the application as a production system.

## Secrets

Check:
- API keys
- JWT secrets
- database credentials
- payment credentials
- Cloudinary credentials

Secrets must not exist in:
- source code
- frontend JavaScript
- Git history
- public files

## Authentication

Verify:
- secure cookies
- expiration
- logout invalidation
- revoked sessions
- authorization

## API

Check:
- validation
- rate limiting
- error handling
- CORS
- security headers
- authentication
- authorization

## Database

Check:
- connection handling
- indexes
- validation
- dangerous queries
- unnecessary data exposure

## Uploads

Check:
- authentication
- authorization
- limits
- file validation
- storage security

## Payments

Check:
- server-side verification
- webhook verification where applicable
- price validation
- subscription state
- duplicate payment handling

## Frontend

Check:
- exposed secrets
- API errors
- authentication state
- production API URL
- broken links
- console errors

## Build

Verify:
- production build
- tests
- lint/type checks when configured

## Final report

PASS:
...

WARNINGS:
...

BLOCKERS:
...

Do not call the application production-ready if critical checks were not verified.