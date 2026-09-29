# Source and dependencies

This native TypeScript implementation adapts the Playground Vibes owner's supplied CLI: its pairing protocol, source/build archive format, project identity, and interrupted-operation handling. The supplied implementation carried `UNLICENSED`; this project retains that setting until its owner chooses distribution terms.

Secret scanning uses the fixed recommended Secretlint ruleset, with comment-based suppression disabled, plus this package's additional checks. Packaging uses `fflate` and Git-style exclusions use `ignore`. Their licenses remain with their respective packages.

The previous Python uploader wrapper is no longer part of this package. Runtime entrypoints are compiled JavaScript; TypeScript declarations are included for API consumers.
