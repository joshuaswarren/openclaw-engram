# Security Policy

## Reporting a vulnerability

Please do not open public issues for suspected vulnerabilities.

Use GitHub Security Advisories for private disclosure:
- https://github.com/joshuaswarren/openclaw-engram/security/advisories/new

If private advisory submission is unavailable, open an issue with minimal details and request secure follow-up.

## Scope

This project handles memory extraction/indexing data and provider credentials.
Security-sensitive areas include:

- Provider/API configuration and credential handling
- Memory storage and retrieval paths
- Tool execution and external model/provider integration
- CI/CD and release automation

## Responsible disclosure expectations

- Provide a clear reproduction path and impact assessment.
- Allow maintainers reasonable time to investigate and fix before public disclosure.
- Avoid accessing or exposing any real user/private data.

## Hard requirements for contributors

- Never commit secrets/tokens.
- Never include personal/private memory data in fixtures, tests, or docs.
- Redact logs before sharing.
