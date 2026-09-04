---
name: manara-health
description: Post-deployment health and regression verification for Manara.
---

# Manara Production Health

Use after deployment or restart.

## Process

Verify:

- application process
- CPU/memory
- application logs
- restart behavior

## HTTP

Verify:

- HTTPS
- homepage
- API health endpoint if available
- expected HTTP status codes

## Database

Verify:

- connection
- queries
- authentication
- no connection errors

## Authentication

Verify:

- login
- authenticated request
- logout
- revoked session
- expired session
- authorization

## Application

Verify critical Manara flows:

- profile
- declarations
- inquiries
- uploads
- subscriptions
- payments

Only test real payment transactions when explicitly requested.

## Errors

Inspect logs for:

- crashes
- uncaught exceptions
- database errors
- repeated 4xx/5xx
- authentication failures
- memory problems

Do not hide or suppress errors.

## Final status

Return:

HEALTHY
DEGRADED
FAILED

Include evidence for the status.