# ADR-0005: Bind application rules to the publication image

Implementation decision within approved I3, November 3, 2026.

Freeze one encrypted publication image for a saved draft revision and staff roster.
Commit all material application fields, excluding the separately editable description,
with a private random salt. The native prototype's optional `app_rules_hash` is part
of its canonical contract rules hash. The salt stays off-chain: a bare hash of a
small set of quiz answers would permit enumeration. Existing prototype terms may
omit the field; the new application publication integration requires it.

Draft/validator changes cannot replace a prepared image. Deletion preserves an
unresolved publication and its required credentials. A matching contract observation
records publication atomically; conflicting terms cannot publish a different draft.
Own export includes scoped metadata, excluding the salt/private image.

This integrates the actual disposable native principal path. It does not qualify
live routes, source independence, execution/prize reserves or complete ingress
coverage. The ordinary publication HTTP route remains disabled. Existing sandbox
deployments are disposable; no public deployment or contract upgrade is performed.
