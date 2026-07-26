feat(release): attest release asset provenance

Release publication now records a GitHub build provenance attestation for every
asset listed in `SHA256SUMS`, so a download can be verified as having come from
this repository's build rather than only matching a checksum published beside
it. See the release guide for the verification command.
