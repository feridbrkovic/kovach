# Security policy

Local Kovach runs terminal commands, reads your files and can act through connected apps, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue.** Report it privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository (Security → Report a vulnerability).

Include what you found, how to reproduce it, and the impact you expect. You'll get an acknowledgement within 7 days.

## In scope

- Prompt injection that leads to actions the user did not approve (commands, file writes, messages sent through connectors)
- Secrets reaching long-term memory, logs or the repository
- Data crossing project boundaries against the project's memory mode
- Escaping approval rules for terminal commands, browser or desktop control

## Supported versions

Only the latest commit on `main` is supported until the first release.
