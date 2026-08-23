# Repository settings checklist

Complete these GitHub settings before changing repository visibility to public.

## Security

- Enable private vulnerability reporting.
- Enable Dependabot alerts and security updates.
- Enable secret scanning and push protection where available.
- Keep Actions permissions read-only by default; grant write permissions only to the job that needs them.
- Review deploy keys, webhooks, Actions secrets, environments, and installed GitHub Apps.
- Remove stale collaborators and require two-factor authentication for maintainers.

## Default branch

- Require pull requests for the default branch.
- Require the CI, secret scan, dependency review, and Rust audit checks.
- Require branches to be up to date before merging.
- Block force pushes and branch deletion.
- Require review for changes to workflows, Tauri capabilities, permission rules, and release configuration.

## Releases

- Protect the release environment and restrict who can approve it.
- Store signing credentials only in protected environment secrets or an external signing service.
- Publish SHA-256 hashes with every executable and installer.
- Clearly label unsigned development artifacts.

## Community

- Set the repository description and topics.
- Link `SECURITY.md`, `CONTRIBUTING.md`, and the code of conduct.
- Confirm that the selected project license is shown by GitHub before announcing the repository.
