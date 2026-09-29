# S3 spike evidence (sandbox and approvals)

Recorded 2026-09-12. Docker and microsandbox are absent. `selectSandbox()`
returns `just-bash`, `non-vm`, `approvalRequired: true`. `justbash({ autoInstall: false })`
so `eve dev` does not silently npm-install the interpreter.

Approval store tests: deny, expiry, modified hash, replay and restart each
produce zero executions. See `spikes/s3/REPORT.md` and `spikes/s3/approvals.test.ts`.
