# A Ranked Lookup Is Not a Model Call

`ltm` may read scores from a ranked index that a Bank opts into. A lookup generates nothing, and the same Bank and index give the same output, so reading one keeps the determinism ADR 0001 protects. A check that uses a ranked backend, such as `near-duplicate` in `ltm doctor`, stays off unless its caller passes a backend.

Which backends qualify, embedding models included, is #132's call.
