---
name: manara-security
description: Security review and secure implementation rules for Manara. Use for authentication, authorization, APIs, uploads, payments, sessions, or security reviews.
---

# Manara Security

Treat all client input as untrusted.

## Authentication

Check:
- JWT validation
- token expiration
- revoked sessions
- logout invalidation
- httpOnly cookies
- Secure cookies in production
- SameSite configuration

Never trust:
- user IDs from the client
- roles from the client
- subscription status from the client

## Authorization

Every protected action must verify:
1. authenticated user
2. ownership or permission
3. required subscription state

Look for:
- IDOR
- privilege escalation
- missing authorization middleware

## Input

Validate:
- body
- params
- query
- uploaded files

Never directly trust user input.

## Web security

Check where relevant:
- XSS
- CSRF
- CORS
- CSP
- HSTS
- X-Content-Type-Options
- clickjacking protection
- rate limiting

## Files

For uploads check:
- authentication
- authorization
- file type
- file size
- filename handling
- storage permissions
- path traversal
- malicious content handling

## Payments

Never trust:
- payment status from frontend
- price from frontend
- subscription duration from frontend

Payment confirmation must be verified server-side.

Never expose:
- API secrets
- payment credentials
- private keys

## Security changes

Do not weaken existing security controls to make tests pass.

If a security test fails:
- identify the actual vulnerability
- fix the root cause
- add or update a regression test

## Output

For every security review report:

CRITICAL
HIGH
MEDIUM
LOW

Only report issues supported by code evidence.
Do not invent vulnerabilities.