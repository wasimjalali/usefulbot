# S3 spike report: sandbox backend and approval enforcement

Generated: 2026-09-12T20:56:42.414Z

| Case | Status | Note |
|---|---|---|
| backend-selection | PASS | neither microsandbox nor docker is installed; just-bash is explicit non-VM and every bash/write_file call requires approval |
| approval-enforcement | PASS | deny, expiry, modified hash, replay and restart cases |
| no-vm-claimed | PASS | in-memory just-bash is not a VM |

## Decision

```json
{
  "backend": "just-bash",
  "isolation": "non-vm",
  "approvalRequired": true,
  "evidenceId": "s3-non-vm-default",
  "reason": "neither microsandbox nor docker is installed; just-bash is explicit non-VM and every bash/write_file call requires approval",
  "binaries": {
    "docker": false,
    "microsandbox": false
  }
}
```

just-bash is pinned with `autoInstall: false`. Production must not download a VM or a package as a silent fallback.
