# A Ranked Lookup Is Not a Model Call

`ltm` may read scores from a ranked index that a Bank opts into. A lookup generates nothing, and the same Bank and the same index give the same output, so it keeps what ADR 0001 protects. Checks that use a ranked backend, such as `near-duplicate` in `ltm doctor`, stay off unless a backend is passed in.

Which backends qualify, embeddings included, is not settled here. That call belongs to #132.
