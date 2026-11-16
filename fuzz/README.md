# Fuzz targets

[cargo-fuzz](https://rust-fuzz.github.io/book/cargo-fuzz.html) targets for the
backend code that reads input from outside: from browsers, from mail servers
and from the settings. Besides crashes and hangs they check properties, e.g.
that an error from a mail server never puts a line break into the log.

| Target | Input |
|---|---|
| `email_address` | Email addresses (`auth::email`), username suggestions, sign-in names, links in system mails |
| `jmap_response` | JMAP session and method responses as the client in `crates/jmap` reads them |
| `mail_headers` | Names and subjects in the headers of system mails |
| `request_headers` | `X-Forwarded-For`, `Cookie` and `User-Agent` |

The crate is outside the Cargo workspace with a lock file of its own, so
libFuzzer stays out of the server build and its license list. Internal entry
points of `roedy-jmap` exist only with `--cfg fuzzing`, which `cargo fuzz` sets.

## Running locally

Needs nightly Rust and `cargo install cargo-fuzz`:

```sh
just fuzz jmap_response -max_total_time=60
```

`just fuzz` starts from the seeds in `fuzz/seeds/<target>/` and the
dictionary in `fuzz/dict/<target>.dict` and keeps new inputs in
`fuzz/corpus/<target>/` (not in Git). A crash ends up in
`fuzz/artifacts/<target>/`; replay it with
`cargo +nightly fuzz run <target> <file>`, fix the cause and add a regular
regression test.

## CI

[ClusterFuzzLite](https://google.github.io/clusterfuzzlite/)
([`.clusterfuzzlite/`](../.clusterfuzzlite), [`fuzz.yml`](../.github/workflows/fuzz.yml))
builds the targets with AddressSanitizer and runs them for five minutes on
pull requests that change Rust code and for an hour every night.
