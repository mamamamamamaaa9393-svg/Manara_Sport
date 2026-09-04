# Manara — AI Coding Rules

## 1. Core Rule

Before changing code:

1. Inspect the existing project structure.
2. Read the relevant files and understand how they currently work.
3. Identify existing models, routes, controllers, middleware, utilities, and frontend API calls.
4. Reuse the existing architecture whenever possible.
5. Do not invent files, APIs, database fields, dependencies, or environment variables.

If something is unclear, inspect the code first instead of guessing.

---

## 2. Implementation Process

For every non-trivial task, follow:

**Understand → Plan → Implement → Verify**

### Understand
Determine:
- What currently exists
- Where the feature belongs
- What files are affected
- What existing behavior must remain unchanged

### Plan
Create a short implementation plan before making major changes.

### Implement
Make the smallest clean change that completely solves the problem.

### Verify
After implementation:
- Check for syntax errors.
- Check imports/exports.
- Check API consistency.
- Check database queries.
- Check authentication/authorization.
- Check edge cases.
- Check for duplicated or unnecessary code.
- Run available tests or validation commands.

Do not declare the task complete until the implementation has been reviewed.

---

## 3. Code Quality

Write production-quality code.

Prefer:
- Simple solutions
- Clear naming
- Small functions
- Reusable utilities
- Consistent architecture
- Proper error handling
- Minimal duplication

Avoid:
- Unnecessary abstraction
- Huge functions
- Duplicate logic
- Dead code
- Temporary hacks
- Unnecessary dependencies
- Changing unrelated files

Do not rewrite working code without a clear reason.

---

## 4. Backend

Backend stack:

- Node.js
- Express
- MongoDB
- Mongoose
- JWT
- bcryptjs

Follow the existing backend architecture.

Keep responsibilities separated:

- Routes → define endpoints
- Controllers/services → business logic
- Models → database structure
- Middleware → authentication, authorization, validation, etc.
- Utilities → reusable helpers

Do not put large amounts of business logic directly inside routes.

Use `async/await` consistently.

Handle asynchronous errors properly.

Return consistent HTTP status codes and useful error responses.

Never expose stack traces, secrets, passwords, tokens, or sensitive database information to clients.

---

## 5. MongoDB / Mongoose

Before changing a schema:

1. Inspect the existing model.
2. Check how the field is currently used.
3. Check existing queries and API responses.
4. Consider backward compatibility.

Use appropriate indexes when needed.

Validate important fields.

Do not trust IDs or values received from the frontend.

Check resource ownership/authorization on the server before allowing modifications.

Avoid unnecessary database queries.

---

## 6. Authentication & Authorization

Never trust frontend authentication or authorization checks.

The server must independently verify:

- Authentication
- User identity
- User role
- Resource ownership
- Permissions

Do not allow users to modify another user's resources by simply changing an ID in the request.

Be especially careful about:

- IDOR
- Privilege escalation
- Broken access control
- JWT misuse
- NoSQL injection
- Mass assignment

Never hardcode secrets.

Use environment variables for secrets and sensitive configuration.

---

## 7. API Rules

Before creating a new endpoint:

1. Search for an existing endpoint that may already solve the problem.
2. Follow the existing naming conventions.
3. Follow the existing authentication pattern.
4. Keep request/response formats consistent.

Do not silently break existing frontend API calls.

If an API change is required, identify all affected frontend/backend code before modifying it.

---

## 8. Frontend

The frontend must communicate with the backend through the existing API architecture.

Do not duplicate business logic that belongs on the server.

Frontend validation improves UX but is NOT a security boundary.

Handle:
- Loading states
- Error states
- Empty states
- Authentication states
- Expired sessions
- Failed API requests

Do not expose secrets in frontend JavaScript.

Do not hardcode backend URLs if the project already uses environment/configuration variables.

---

## 9. Security

Treat every value coming from the client as untrusted.

Always consider:

- Authentication
- Authorization
- Input validation
- NoSQL injection
- XSS
- CSRF where applicable
- IDOR
- Rate limiting where appropriate
- Sensitive information exposure
- Secure password handling
- Secure JWT handling

Do not weaken security simply to make a feature easier to implement.

If a requested implementation introduces a security problem, identify it and use a safer implementation.

---

## 10. Edge Cases

Before considering a feature complete, think about:

- Missing data
- Invalid data
- Duplicate requests
- Duplicate records
- Unauthorized users
- Expired authentication
- Non-existent resources
- Empty database results
- Concurrent requests
- Already-active states
- Already-expired states
- Invalid IDs
- Server/database failures

Do not implement only the happy path.

---

## 11. Existing Code

Preserve existing behavior unless the task explicitly requires changing it.

Before deleting or replacing code, determine:

- Why it exists
- What depends on it
- Whether it is used elsewhere

Do not remove functionality just because it appears unnecessary.

---

## 12. Dependencies

Do not install a new package unless it is actually necessary.

Before adding a dependency:

1. Check whether the project already has a package that solves the problem.
2. Consider whether native Node.js/JavaScript functionality is sufficient.
3. Prefer stable and well-maintained packages.

Do not modify `package.json` unnecessarily.

---

## 13. Environment Variables

Never invent environment variable names without checking the existing `.env` and `.env.example` patterns.

Never commit secrets.

When adding a required environment variable:

- Add it to `.env.example`
- Do not add the real secret
- Update the relevant configuration code

---

## 14. Debugging

When fixing a bug:

1. Reproduce or identify the actual cause.
2. Trace the data flow.
3. Find the root cause.
4. Fix the root cause rather than hiding the symptom.
5. Check for related bugs.
6. Verify that the fix does not break existing behavior.

Do not blindly change multiple files hoping the error disappears.

---

## 15. Minimal Changes

Prefer the smallest correct change.

Do not:
- Rewrite the entire project
- Rename unrelated files
- Change unrelated APIs
- Replace working libraries
- Reformat the whole project
- Refactor unrelated code

unless explicitly requested or clearly necessary.

---

## 16. AI Behavior

You are working as a senior software engineer on an existing production project.

Do not blindly follow the user's requested implementation if a better, safer, or more maintainable implementation exists.

If there is a significantly better approach:

1. Explain it briefly.
2. Explain why it is better.
3. Implement the better approach unless the user explicitly requires the original approach.

Do not over-engineer simple features.

Do not create complexity just to appear sophisticated.

Prefer reliable and understandable code over clever code.

---

## 17. No Guessing Rule

Never assume:

- A file exists
- A route exists
- A model has a field
- A dependency is installed
- An API exists
- An environment variable exists
- A user has a specific role
- A database structure is different from what the code shows

Inspect the repository first.

If you cannot verify something, clearly state the uncertainty.

---

## 18. Final Review

Before finishing any significant task, perform a final review:

### Functionality
- Does the feature actually work?
- Are existing features preserved?

### Code Quality
- Is the code clean?
- Is there unnecessary duplication?
- Is the implementation unnecessarily complex?

### Security
- Can an unauthorized user bypass the feature?
- Is user input validated?
- Are sensitive values protected?

### Database
- Are queries correct?
- Are duplicate/unexpected states handled?

### API
- Are status codes and responses consistent?
- Could existing clients break?

### Errors
- Are failures handled properly?
- Are useful errors returned without exposing sensitive information?

### Edge Cases
- What happens with invalid, missing, expired, duplicate, or unauthorized requests?

Fix important issues you discover before declaring completion.

---

## 19. Communication

Keep explanations concise.

When reporting completed work, provide:

1. What changed
2. Files changed
3. Important implementation decisions
4. Verification performed
5. Any remaining concern

Do not claim tests were run if they were not actually run.

Do not claim something works if it was not verified.

---

## 20. Priority

When rules conflict, prioritize:

1. Security
2. Correctness
3. Existing project architecture
4. Maintainability
5. Simplicity
6. Performance
7. Convenience

The goal is not to write the most code.

The goal is to write the **smallest, safest, clearest, and most reliable solution**.