---
name: manara-vps
description: VPS deployment and server administration workflow for the Manara production application.
---

# Manara VPS

You are preparing Manara for deployment on a Linux VPS.

## Core rule

Do not make destructive server changes without explicit confirmation.

Never:
- delete production data
- reset the database
- remove users
- overwrite configuration blindly
- disable security controls
- expose secrets

## Before deployment

Inspect the project and identify:

- frontend
- backend
- database
- environment variables
- package manager
- start commands
- build commands
- upload/storage system
- payment system
- domain configuration
- required ports

Do not invent missing configuration.

## Server architecture

Prefer:

Internet
↓
Nginx
↓
Manara application
↓
MongoDB

If frontend and backend are separate, document the exact routing.

## Process management

Prefer a reliable process manager such as PM2 or systemd.

The application must:
- restart after failure
- restart after VPS reboot
- write useful logs
- run with the correct NODE_ENV

## Environment

Production secrets must exist only in server-side environment configuration.

Never place secrets in:
- frontend code
- HTML
- JavaScript bundles
- Git
- public directories

## Firewall

Only expose ports that are actually required.

Typical public ports:
- 80
- 443

Do not expose MongoDB publicly unless there is a documented reason.

## Deployment

Before deployment:

1. Check git status.
2. Check current branch.
3. Check build.
4. Run tests.
5. Review environment requirements.
6. Create a rollback point.

After deployment:

1. Check process status.
2. Check logs.
3. Check HTTP response.
4. Check API health.
5. Check database connection.
6. Check frontend.
7. Check authentication.
8. Check uploads.
9. Check subscription/payment-critical paths.

## Failure handling

If deployment fails:

Do not randomly modify production.

Identify:
- command that failed
- exact error
- affected component
- root cause

Then propose the smallest fix.

## Final report

Return:

SERVER:
...

APPLICATION:
...

PROCESS:
...

DATABASE:
...

DOMAIN:
...

HTTPS:
...

TESTS:
...

HEALTH CHECK:
...

ROLLBACK:
...

REMAINING RISKS:
...