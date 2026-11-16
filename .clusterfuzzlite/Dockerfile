# Build image for ClusterFuzzLite (.github/workflows/fuzz.yml): the targets
# in fuzz/ with libFuzzer and the sanitizers of OSS-Fuzz.
FROM gcr.io/oss-fuzz-base/base-builder-rust@sha256:3428d0a90b1e7efbe2ba947bd1d0c9a70594986b4b6553804547f1fb24cfc92f

# The image's nightly is older than the dependencies need; a fixed one keeps
# the build reproducible.
ENV RUSTUP_TOOLCHAIN=nightly-2026-11-01
RUN rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal --component rust-src

COPY . $SRC/mail
WORKDIR $SRC/mail
COPY .clusterfuzzlite/build.sh $SRC/
