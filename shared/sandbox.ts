import { execFileSync } from "node:child_process";
import type { Isolation, SandboxBackendName } from "./policy.ts";

export interface SandboxDecision {
  backend: SandboxBackendName;
  isolation: Isolation;
  approvalRequired: boolean;
  evidenceId: string;
  reason: string;
  binaries: { docker: boolean; microsandbox: boolean };
}

function commandExists(name: string): boolean {
  try {
    execFileSync("/usr/bin/which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function selectSandbox(pin?: string, which: (name: string) => boolean = commandExists): SandboxDecision {
  const docker = which("docker");
  const microsandbox = which("microsandbox") || which("msb");
  // The owner's runtime config pins the backend. A binary sitting on PATH
  // must not silently upgrade what the config pinned, so the pin wins over
  // the sniffing below; the binaries are still reported for the setup and
  // verify scripts.
  if (pin === "just-bash") {
    return {
      backend: "just-bash",
      isolation: "non-vm",
      approvalRequired: true,
      evidenceId: "s3-non-vm-default",
      reason: "the runtime config pins just-bash; installed VM binaries do not upgrade the backend",
      binaries: { docker, microsandbox },
    };
  }
  if (microsandbox) {
    return {
      backend: "microsandbox",
      isolation: "verified-vm",
      approvalRequired: true,
      evidenceId: "pending-s3-isolation",
      reason: "microsandbox binary is present; isolation tests must still pass before production pin",
      binaries: { docker, microsandbox: true },
    };
  }
  if (docker) {
    return {
      backend: "docker",
      isolation: "verified-vm",
      approvalRequired: true,
      evidenceId: "pending-s3-isolation",
      reason: "docker binary is present; macOS VM isolation tests must still pass before production pin",
      binaries: { docker: true, microsandbox: false },
    };
  }
  return {
    backend: "just-bash",
    isolation: "non-vm",
    approvalRequired: true,
    evidenceId: "s3-non-vm-default",
    reason: "neither microsandbox nor docker is installed; just-bash is explicit non-VM and every bash/write_file call requires approval",
    binaries: { docker: false, microsandbox: false },
  };
}
