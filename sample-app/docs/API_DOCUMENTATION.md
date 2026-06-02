# API Developer Documentation & Reference

Welcome to the Developer Portal. Here you can find specifications for REST endpoints, schemas, and traffic policies.

## Connection Policy

All API requests must be secure. Ensure requests use SSL endpoints.

## Rate Limiting (Traffic Rules)

To prevent denial of service attacks and maintain high system throughput, we enforce rigorous rate limits on our API requests per account level:

- **Free Tier Rate Limit**: Accounts on the free plan are allowed up to `60` requests per minute (RATE_LIMIT_FREE).
- **Pro Tier Rate Limit**: Upgraded active Pro accounts enjoy an elevated capacity of up to `1000` requests per minute (RATE_LIMIT_PRO).

If a client exceeds these requests, our gateway will respond with `429 Too Many Requests`.

## Governance & Telemetry

Conversion funnels and upgrade attempts are tracked in Google Analytics using telemetry tracker ID `UA-123456789-1` (GOOGLE_ANALYTICS_ID).
