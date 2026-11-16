#!/bin/bash -eu
# Builds the fuzz targets in fuzz/ for ClusterFuzzLite, with seed corpora
# (fuzz/seeds/<target>) and dictionaries (fuzz/dict/<target>.dict).

cd "$SRC/mail"
cargo fuzz build -O --debug-assertions

for source in fuzz/fuzz_targets/*.rs; do
  target=$(basename "$source" .rs)
  cp "fuzz/target/x86_64-unknown-linux-gnu/release/$target" "$OUT/"
  if [ -d "fuzz/seeds/$target" ]; then
    zip -jq "$OUT/${target}_seed_corpus.zip" "fuzz/seeds/$target"/*
  fi
  if [ -f "fuzz/dict/$target.dict" ]; then
    cp "fuzz/dict/$target.dict" "$OUT/"
  fi
done
