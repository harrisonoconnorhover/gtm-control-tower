# Source recovery snapshot

This recovery branch preserves reviewed application source and documentation as of 18 October 2026. It is parented on the existing public main branch and does not import unpublished local commit history.

The snapshot excludes ignored databases, credentials, local runtime state, generated operational artifacts and local working configuration. Documentation workspace/contact identifiers were replaced with placeholders. Restore application data and credentials separately before attempting to resume work. Nothing was deployed by creating this branch.

This snapshot also preserves the handoff-audit source, documentation and tests from the reviewed local working changes.
