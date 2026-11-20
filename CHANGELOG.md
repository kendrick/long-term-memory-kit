# Changelog

## [0.4.0](https://github.com/kendrick/long-term-memory-kit/compare/v0.3.0...v0.4.0) (2026-11-20)


### Features

* **doctor:** report accepted Exceptions whose PolicyRule isn't accepted ([#225](https://github.com/kendrick/long-term-memory-kit/issues/225)) ([aa634d7](https://github.com/kendrick/long-term-memory-kit/commit/aa634d7c058b4760b7fa72dc62b0563b8412e9dd))
* **query:** leave expired Exceptions out of ltm query and report them in ltm doctor ([#234](https://github.com/kendrick/long-term-memory-kit/issues/234)) ([f0ba60f](https://github.com/kendrick/long-term-memory-kit/commit/f0ba60fa98d1a8d0fc6cb7ea61b5bf9cef8ec8ba))


### Bug Fixes

* **fmt:** refuse a Record that changed on disk since fmt read it ([#235](https://github.com/kendrick/long-term-memory-kit/issues/235)) ([6eaf85c](https://github.com/kendrick/long-term-memory-kit/commit/6eaf85c2c40e52dc069a6d86b012a21e36fe25df))
* **publish:** refuse dot segments and backslashes in sharepoint site, drive, and path ([#223](https://github.com/kendrick/long-term-memory-kit/issues/223)) ([39bef0e](https://github.com/kendrick/long-term-memory-kit/commit/39bef0e5b7b2de63fe76355f2b33bbec19e81b30))
* **qmd-vector:** name the missing store.internal member and qmd version instead of a TypeError ([#229](https://github.com/kendrick/long-term-memory-kit/issues/229)) ([ca99b56](https://github.com/kendrick/long-term-memory-kit/commit/ca99b566e8774dc96719c3fbbb9629b7e5a88bbe))
* **qmd:** run the npm qmd.cmd shim on Windows without a shell ([#231](https://github.com/kendrick/long-term-memory-kit/issues/231)) ([0a729d5](https://github.com/kendrick/long-term-memory-kit/commit/0a729d5c64fffc49d86fcc3f0b82c28ad32d8f79))
* **test:** isolate git-bank scratch repos from global and system git config ([#238](https://github.com/kendrick/long-term-memory-kit/issues/238)) ([16700c1](https://github.com/kendrick/long-term-memory-kit/commit/16700c1502998c1d09bbe38342102679a4d6daa9))

## [0.3.0](https://github.com/kendrick/long-term-memory-kit/compare/v0.2.0...v0.3.0) (2026-11-13)


### Features

* **cli:** group ltm --help by task, with a tagline and a next step ([#216](https://github.com/kendrick/long-term-memory-kit/issues/216)) ([7768173](https://github.com/kendrick/long-term-memory-kit/commit/7768173b1d8354a28f808b136b9d89002ed4c1fe))
