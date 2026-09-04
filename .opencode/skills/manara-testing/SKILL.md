---
name: manara-testing
description: Testing workflow for Manara. Use after bug fixes, security changes, API changes, authentication changes, or feature implementation.
---

# Manara Testing

Tests are evidence.

Never say a change works without verification.

## Workflow

Before modifying code:

1. Find existing tests.
2. Identify the expected behavior.
3. Reproduce the problem when possible.

After modifying code:

1. Run the smallest relevant test.
2. Run related tests.
3. Run the full suite when practical.

## Bug fixes

For every reproducible bug:

- create or update a regression test
- reproduce failure
- apply fix
- confirm test passes

## Security

For security fixes test:
- allowed request
- unauthorized request
- expired session
- revoked session
- invalid input
- privilege boundary

## API tests

Check:
- status code
- response body
- authentication
- authorization
- validation
- error handling

## Frontend

Check:
- API error handling
- loading states
- empty states
- authentication state
- responsive behavior when relevant

## Never

Do not:
- delete tests just to make them pass
- weaken assertions
- skip failing tests without explaining why
- fabricate test results

## Final report

Use:

TESTS RUN:
- command

RESULT:
- PASS / FAIL

REGRESSION:
- checked / not checked

If a test was not run, say so.