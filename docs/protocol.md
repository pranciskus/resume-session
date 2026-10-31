# Sharing API contract

Client/server compatibility uses `resume-handoff/1` (see [job format](job-format.md)). Requests use `Authorization: Bearer TOKEN` over HTTPS, with loopback HTTP allowed for local development. Clients reject redirects.

| Request | Success response |
| --- | --- |
| `POST /v1/handoffs` | `201` JSON: `id`, `expiresAt` (ISO timestamp), `sha256` |
| `GET /v1/handoffs/rs_ID` | `200` binary checkpoint, `Content-Length`, `X-Content-SHA256` |
| `DELETE /v1/handoffs/rs_ID` | `204`, idempotent revocation |
| `GET /health` | `200` JSON health response; no authentication required |

Uploads use `Content-Type: application/octet-stream` and contain gzip-compressed UTF-8 checkpoint JSON, without HTTP content encoding. Limits are 32 MiB compressed and 32 MiB expanded. SHA-256 covers compressed bytes. IDs match `^rs_[A-Za-z0-9_-]{24}$`. Downloads are repeatable until expiry or revocation.

Error responses use JSON `{ "error": "message" }`: `400` malformed/empty input, `401` authentication, `404` missing/expired/revoked ID, `405` method, `413` size, `415` content type, `500` service failure, `503` temporary capacity, `507` storage quota.

The private infrastructure repository pins this public repository as its `client` submodule. Integration tests run against that exact revision, and the server imports the shared protocol constants from it. Breaking protocol changes require coordinated client/server versioning.
