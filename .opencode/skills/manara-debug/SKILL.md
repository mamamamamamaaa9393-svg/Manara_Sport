---
name: manara-debug
description: Root-cause debugging workflow for Manara errors and unexpected behavior.
---

# Manara Debugging

Do not guess.

## Process

1. Read the complete error.
2. Identify where it originates.
3. Trace the execution path.
4. Inspect related code.
5. Reproduce the problem.
6. Find the root cause.
7. Fix the smallest responsible component.
8. Test the fix.

## Evidence

Prefer:
- stack traces
- logs
- failing tests
- HTTP status codes
- request/response data
- database errors

Do not treat symptoms as the root cause.

## Avoid

Do not:
- randomly change multiple files
- rewrite working systems
- add dependencies without need
- hide errors
- remove validation
- suppress exceptions

## If uncertain

State:
- what is known
- what is unknown
- what was checked

Then investigate before modifying code.

## Final answer

ROOT CAUSE:
...

FIX:
...

FILES:
...

VERIFICATION:
...

REMAINING RISK:
...