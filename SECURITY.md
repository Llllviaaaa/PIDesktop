# Security Policy

Pi Desktop runs local tools with the permissions of the desktop user. Its approval modes reduce accidental tool use, but they are not an operating-system sandbox.

## Supported versions

Security fixes are applied to the latest release and the default development branch. Older releases may not receive backports.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. Do not include exploit details, credentials, private workspace contents, or other sensitive data in a public issue.

If private vulnerability reporting is unavailable, open a public issue that only requests a private security contact. Do not describe the vulnerability in that issue.

Useful reports include:

- the affected version or commit;
- the operating system and runtime configuration;
- a minimal reproduction using synthetic data;
- the expected and actual security boundary;
- the likely impact and any known mitigations.

The maintainers will aim to acknowledge a report within seven days. Disclosure timing will be coordinated after the issue is reproduced and a remediation plan exists.

## High-impact areas

Please report suspected problems involving:

- command execution or permission-mode bypasses;
- credential storage, redaction, or unintended environment inheritance;
- path traversal or access outside the selected workspace;
- untrusted MCP servers, browser automation, or native computer control;
- session, checkpoint, or worktree corruption;
- WebView injection, unsafe navigation, or CSP bypasses;
- scheduled task execution without the documented approval boundary.

## Deployment boundary

`full-access` grants Pi the permissions of the desktop user. Run untrusted prompts, repositories, extensions, skills, MCP servers, and unattended tasks inside a VM, container, Windows Sandbox, or another policy-controlled environment.
