# Data Security & Encryption Guidelines

This document details the system-wide cryptographic and compliance specifications.

## Cryptographic Standards

To maintain active GDPR and HIPAA certification, all sensitive payloads (including access tokens, personal identifiers, and billing details) must be encrypted using the specified symmetric standard:

- **Encryption Standard**: `AES-256-GCM` (ENCRYPTION_ALGORITHM)
- **Key Derivation**: PBKDF2 with 100,000 iterations.

## Data Retention and Compliance

- **Data Retention Limit**: In compliance with user privacy rights, all system databases and offline records retain historical user metrics for exactly `90` days (DATA_RETENTION_DAYS) following deletion of the primary account.
- **Audit Logging**: All decryption attempts are logged with Google Analytics (UA-123456789-1).
