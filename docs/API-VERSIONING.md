# API versioning and deprecation policy

The major API version appears in the URL, starting with `/v1`.

A breaking change removes or renames an endpoint or response field, changes a field type or meaning, tightens existing input requirements, changes authentication requirements, or changes pagination or error semantics in a way that requires clients to update. Introduce breaking contract changes under a new major version.

Adding an endpoint, optional request parameter with compatible defaults, or optional response field is generally non-breaking. Clients should tolerate unknown response fields. Adding enum values requires checking whether the existing contract requires clients to handle a closed set.

Announce deprecations in the release notes and API reference. Identify the affected endpoint or field, its replacement, the migration steps, and the earliest removal date. For deprecated endpoints, communicate the schedule in response headers where supported. Keep deprecated behavior available for at least 90 days after notice. If removal would break the existing contract, introduce it in a new major version and keep the older version available for the announced window.
