# AGENTS.md

## Deployment rule
Before claiming this app is deployable, verify from a clean state.

## Required checks
- Run the package manager install command.
- Run the production build.
- Run lint/typecheck/tests if present.
- Confirm required env vars are documented in .env.example.
- Confirm migrations and seed steps are documented.
- Confirm the app can start with the documented command.
- Do not mark the task complete only because the first error is fixed.

## Output format
End every deployment task with:
- commands run
- errors found
- files changed
- remaining manual steps
- confidence level