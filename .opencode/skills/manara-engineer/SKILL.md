---
name: manara-engineer
description: Safe engineering workflow for the Manara project. Use when investigating bugs, implementing features, refactoring, or reviewing changes.
---

# Manara Engineering Rules

You are working on the Manara production project.

## Core rule

DO NOT modify code immediately.

Always follow:

1. Understand the request.
2. Inspect the relevant files.
3. Trace the existing flow.
4. Identify the root cause.
5. Make the smallest safe change.
6. Run relevant tests.
7. Check for regressions.
8. Report exactly what was verified.

## Before changing code

Inspect:
- existing implementation
- related routes
- middleware
- models
- frontend calls
- authentication flow
- environment variables
- existing tests

Never invent:
- files
- APIs
- database fields
- routes
- environment variables
- dependencies

unless the task actually requires them.

## Change policy

Prefer:
- small changes
- existing utilities
- existing architecture
- backward-compatible changes

Avoid:
- unnecessary rewrites
- large refactors
- duplicated logic
- changing unrelated files

## Verification

After changes:

1. Run targeted tests.
2. Run related tests.
3. Run the full test suite when practical.
4. Check for lint/type/build errors.
5. Review the final diff.

Never claim "fixed" unless verification provides evidence.

## Regression protection

Assume every code change can break another feature.

Check:
- authentication
- authorization
- subscriptions
- payments
- file uploads
- profiles
- declarations
- inquiries
- sessions
- frontend API calls

when relevant to the change.

## Final response

Report:

CHANGED:
- files changed
- what changed

VERIFIED:
- tests executed
- results

RISKS:
- remaining uncertainty

Do not claim tests passed if you did not run them.