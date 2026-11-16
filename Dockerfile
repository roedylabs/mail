# syntax=docker/dockerfile:1
#
# Roedy Mail image. The Dockerfile only packages: web app
# and binary are built beforehand with `just dist` (in CI via release.yml) –
# statically linked musl binaries with the embedded SPA under
# dist/<amd64|arm64>/roedy-mail. Then `docker buildx build --platform
# linux/amd64,linux/arm64 .` builds without emulation, because no stage runs
# code of the target platform.

# File system for scratch: CA certificates, /data for USER 65532, /tmp for SQLite.
FROM --platform=$BUILDPLATFORM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS rootfs
RUN apk add --no-cache ca-certificates \
 && mkdir -p /rootfs/etc/ssl/certs /rootfs/data /rootfs/tmp \
 && cp /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/ \
 && chown 65532:65532 /rootfs/data \
 && chmod 0700 /rootfs/data \
 && chmod 1777 /rootfs/tmp

FROM scratch
ARG TARGETARCH
LABEL org.opencontainers.image.title="Roedy Mail" \
      org.opencontainers.image.description="Lightweight JMAP webmailer for Stalwart" \
      org.opencontainers.image.url="https://github.com/roedylabs/mail" \
      org.opencontainers.image.source="https://github.com/roedylabs/mail" \
      org.opencontainers.image.documentation="https://github.com/roedylabs/mail/blob/main/docs/ops.md" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=rootfs /rootfs/ /
COPY --chmod=0755 dist/${TARGETARCH}/roedy-mail /usr/local/bin/roedy-mail
COPY LICENSE /usr/share/doc/roedy-mail/LICENSE
# mimalloc returns free memory immediately and uses no Transparent Huge Pages:
# otherwise the idle server keeps what startup and logins (Argon2, 19 MiB per
# password) allocated – 15 instead of 40–58 MB when idle.
ENV PATH=/usr/local/bin \
    ROEDY_DATA_DIR=/data \
    MIMALLOC_PURGE_DELAY=0 \
    MIMALLOC_ALLOW_THP=0
USER 65532:65532
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=1s --retries=3 \
  CMD ["roedy-mail", "healthcheck"]
ENTRYPOINT ["roedy-mail"]
CMD ["serve"]
