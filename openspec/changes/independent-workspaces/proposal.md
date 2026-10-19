## Why

Desk's default configuration and Compose overlay belong to a particular product. Opening another
project currently requires editing the Desk checkout, and new initiatives assume a staging branch.

## What

Keep product profiles and Compose overlays in their owning workspace. Select a configuration with
`--config` or `SPEC_REVIEW_CONFIG` across server startup and container authentication. Default to
the configuration directory and Git HEAD, with explicit repository and optional runner settings.
Preserve the existing product's repositories, runner, routing settings and staging base in its hub.

This is a configuration and deployment refactor. The existing owner workflow contracts remain
unchanged. Startup argument parsing and path resolution are verified manually, without translating
technical assertions into additional product contracts or adding a technical test suite.
