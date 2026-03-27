# Distribution Note

Processed bundles are the runtime distribution target.

## Distribution Policy

- source assets stay offline inputs
- processed bundles are the only runtime-facing payload
- large generated bundles are not assumed to be committed to this repository
- the repository tracks format specs, validators, and a minimal public fixture

## Consequence

Future release packaging must version the processed bundle independently from
the application shell so that host integration can reason about compatibility.
