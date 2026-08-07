# Security Policy

## Supported Versions

The latest minor release line is supported for security fixes. Prior minor
lines receive fixes on a best-effort basis.

## Scope

This policy covers the published npm package `scoutline`, the CLI runtime,
and the on-disk credential storage. Development dependencies are out of
scope unless they affect the published package.

## Secret-Handling Guarantees

Scoutline recursively redacts credential values at every outward boundary —
stdout output, stderr error envelopes, diagnostic output, the response cache,
the tool-discovery cache, and fatal shell errors. Credentials configured via
`config.json` or environment variables are resolved at invocation time and
never written to logs. API keys are stored at rest in plaintext JSON (mode
0600, directory 0700), consistent with AWS CLI, gcloud, and kubectl.

## Reporting a Vulnerability

If you believe you have found a security vulnerability, please do not open a
public issue.

Preferred reporting:
1. Use GitHub Security Advisories for this repository ("Report a vulnerability").
2. If advisories are unavailable, open a private issue with minimal details and
   request a secure follow-up channel.

We will acknowledge receipt within 72 hours and provide a timeline for a fix
once the issue is validated.
