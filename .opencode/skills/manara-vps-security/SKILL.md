---
name: manara-vps-security
description: Production VPS security audit for Manara.
---

# Manara VPS Security

Review the VPS and application as a production security system.

## SSH

Check:

- SSH configuration
- key-based authentication
- root login policy
- password authentication policy
- exposed SSH port

Do not disable the only working administrator access.

## Firewall

Check:

- public ports
- unnecessary exposed services
- MongoDB exposure
- application port exposure

Prefer exposing only:
- 80
- 443
- SSH administration port as required

## Nginx

Check:

- HTTPS
- HTTP redirect
- security headers
- reverse proxy
- request size limits
- sensitive file exposure

## Application

Check:

- production NODE_ENV
- debug mode
- stack traces
- CORS
- cookies
- authentication
- authorization
- rate limiting
- input validation

## Secrets

Search for accidental exposure of:

- JWT secrets
- database credentials
- payment credentials
- Cloudinary credentials
- API keys

Never output actual secret values.

## Database

MongoDB should not be publicly accessible unless explicitly required.

Check:
- bind configuration
- authentication
- network exposure
- backups

## Files

Check that these are not publicly accessible:

- .env
- Git files
- logs containing secrets
- private configuration
- source maps when inappropriate
- internal files

## Updates

Check outdated packages and server components.

Do not automatically upgrade production dependencies without checking compatibility.

## Report

Classify findings:

CRITICAL
HIGH
MEDIUM
LOW

For every finding provide:

- evidence
- affected component
- risk
- recommended fix

Do not invent vulnerabilities.