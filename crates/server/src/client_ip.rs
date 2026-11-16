//! Client IP for rate limits, sessions and the audit log.
//!
//! Without `ROEDY_TRUST_PROXY`, the address of the TCP connection counts. With
//! N proxies, the client is N entries before the end of `X-Forwarded-For`:
//! every proxy appends the address it received the request from. Entries
//! further left can be set by the client itself and do not count.

use std::net::{IpAddr, Ipv6Addr, SocketAddr};

use anyhow::anyhow;

use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{HeaderMap, request::Parts},
};

use crate::{api::ApiError, app::AppState, config::TrustProxy};

const X_FORWARDED_FOR: &str = "x-forwarded-for";

/// Address of the client according to `ROEDY_TRUST_PROXY`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientIp(pub IpAddr);

impl ClientIp {
    /// Key for rate limits: IPv4 per address, IPv6 per /64 – the least a
    /// single connection receives.
    pub fn network(self) -> IpAddr {
        match self.0 {
            IpAddr::V4(v4) => IpAddr::V4(v4),
            IpAddr::V6(v6) => {
                let prefix = u128::from(v6) & !((1u128 << 64) - 1);
                IpAddr::V6(Ipv6Addr::from(prefix))
            }
        }
    }
}

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // Without the connection address all clients would share one counter;
        // `app::serve` provides it, tests use `MockConnectInfo`.
        let ConnectInfo(peer) = ConnectInfo::<SocketAddr>::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::Internal(anyhow!("connection address missing (ConnectInfo)")))?;
        Ok(Self(resolve(peer.ip(), &parts.headers, state.trust_proxy)))
    }
}

/// Determines the client IP from the connection and `X-Forwarded-For`. If the
/// list is shorter than configured, its first entry counts; an unreadable
/// entry ends the search at the last readable one. Parsing works per entry,
/// not per line: a proxy appends its entry to the client's line, and a byte
/// outside ASCII there must not discard it along with the whole line.
pub fn resolve(peer: IpAddr, headers: &HeaderMap, trust: TrustProxy) -> IpAddr {
    let mut client = peer.to_canonical();
    if !trust.enabled() {
        return client;
    }
    let entries: Vec<&str> = headers
        .get_all(X_FORWARDED_FOR)
        .iter()
        .flat_map(|v| v.as_bytes().split(|&b| b == b','))
        // Unreadable becomes empty and ends the search like any other entry
        // that is not an address.
        .map(|entry| std::str::from_utf8(entry.trim_ascii()).unwrap_or(""))
        .collect();
    for entry in entries.iter().rev().take(trust.hops()) {
        match parse(entry) {
            Some(ip) => client = ip.to_canonical(),
            None => break,
        }
    }
    client
}

fn parse(entry: &str) -> Option<IpAddr> {
    entry
        .parse::<IpAddr>()
        .ok()
        .or_else(|| entry.parse::<SocketAddr>().ok().map(|s| s.ip()))
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn headers(values: &[&'static str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for v in values {
            headers.append(X_FORWARDED_FOR, HeaderValue::from_static(v));
        }
        headers
    }

    #[test]
    fn ignores_header_without_trusted_proxy() {
        let h = headers(&["198.51.100.1"]);
        assert_eq!(resolve(ip("10.0.0.2"), &h, TrustProxy(0)), ip("10.0.0.2"));
    }

    #[test]
    fn takes_entry_added_by_trusted_proxies() {
        let peer = ip("10.0.0.2");
        // The client set "6.6.6.6" itself; the proxy appends the real one.
        let h = headers(&["6.6.6.6, 198.51.100.1"]);
        assert_eq!(resolve(peer, &h, TrustProxy(1)), ip("198.51.100.1"));
        // Two proxies (CDN, then reverse proxy), also across two header lines.
        let h = headers(&["6.6.6.6, 198.51.100.1", "203.0.113.9"]);
        assert_eq!(resolve(peer, &h, TrustProxy(2)), ip("198.51.100.1"));
        assert_eq!(resolve(peer, &h, TrustProxy(10)), ip("6.6.6.6"));
    }

    #[test]
    fn falls_back_to_peer_and_last_readable_entry() {
        let peer = ip("10.0.0.2");
        assert_eq!(resolve(peer, &HeaderMap::new(), TrustProxy(1)), peer);
        assert_eq!(resolve(peer, &headers(&["unknown"]), TrustProxy(1)), peer);
        let h = headers(&["198.51.100.1, unknown, 203.0.113.9"]);
        assert_eq!(resolve(peer, &h, TrustProxy(3)), ip("203.0.113.9"));
    }

    /// nginx with `$proxy_add_x_forwarded_for` appends to the client's line; a
    /// byte outside ASCII there must not discard the whole line, otherwise
    /// the proxy's address would count.
    #[test]
    fn reads_entries_after_bytes_outside_ascii() {
        let peer = ip("10.0.0.2");
        let mut h = HeaderMap::new();
        h.append(
            X_FORWARDED_FOR,
            HeaderValue::from_bytes(b"\xff, 198.51.100.1").unwrap(),
        );
        assert_eq!(resolve(peer, &h, TrustProxy(1)), ip("198.51.100.1"));
        // Further ahead, the unreadable entry ends the search.
        assert_eq!(resolve(peer, &h, TrustProxy(2)), ip("198.51.100.1"));
    }

    #[test]
    fn accepts_ports_and_mapped_addresses() {
        let peer = ip("10.0.0.2");
        let h = headers(&["198.51.100.1:4711"]);
        assert_eq!(resolve(peer, &h, TrustProxy(1)), ip("198.51.100.1"));
        let h = headers(&["[2001:db8::1]:4711"]);
        assert_eq!(resolve(peer, &h, TrustProxy(1)), ip("2001:db8::1"));
        assert_eq!(
            resolve(ip("::ffff:192.0.2.1"), &HeaderMap::new(), TrustProxy(0)),
            ip("192.0.2.1")
        );
    }

    #[test]
    fn network_groups_ipv6_by_64() {
        assert_eq!(ClientIp(ip("192.0.2.1")).network(), ip("192.0.2.1"));
        assert_eq!(
            ClientIp(ip("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).network(),
            ip("2001:db8:1:2::")
        );
    }
}
