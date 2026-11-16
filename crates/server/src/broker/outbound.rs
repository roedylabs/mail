//! Requests to addresses from users (custom servers): only to
//! public addresses, so that nobody reaches internal services through the
//! backend (SSRF). The registry's servers are maintained by the administrator; for them
//! [`super::http_client`] applies without this guard.
//!
//! Two stages: [`check_public`] checks in advance and names the reason, the
//! resolver of [`public_client`] checks again on every connection –
//! otherwise a DNS record could switch to an internal address between check
//! and connection (DNS rebinding).

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
};

use anyhow::Context as _;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use url::{Host, Url};

/// Why an address is not allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blocked {
    /// The name does not resolve.
    Unresolvable,
    /// At least one address lies in a non-public network.
    Private,
}

impl std::fmt::Display for Blocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unresolvable => "address does not resolve",
            Self::Private => "address lies in a non-public network",
        })
    }
}

impl std::error::Error for Blocked {}

/// HTTP client for addresses from users: connects only to
/// public addresses and without a proxy (a proxy would resolve the name itself,
/// bypassing this resolver).
pub fn public_client() -> anyhow::Result<reqwest::Client> {
    super::client_builder()
        .no_proxy()
        .dns_resolver(Arc::new(PublicOnly))
        .build()
        .context("HTTP client for custom servers not created")
}

/// Checks in advance whether `url` points only to public addresses. reqwest asks
/// no resolver for IP addresses in the URL; only this function checks them.
pub async fn check_public(url: &Url) -> Result<(), Blocked> {
    match url.host() {
        Some(Host::Ipv4(ip)) => is_public(IpAddr::V4(ip))
            .then_some(())
            .ok_or(Blocked::Private),
        Some(Host::Ipv6(ip)) => is_public(IpAddr::V6(ip))
            .then_some(())
            .ok_or(Blocked::Private),
        Some(Host::Domain(name)) => public_addrs(name).await.map(drop),
        None => Err(Blocked::Unresolvable),
    }
}

/// All addresses of `host` if each is public. A single internal one
/// is enough to reject: the client decides itself which one it takes.
async fn public_addrs(host: &str) -> Result<Vec<SocketAddr>, Blocked> {
    // Without our own limit the system's timeout would apply (often 10–30 s).
    let addrs: Vec<SocketAddr> =
        tokio::time::timeout(super::CONNECT_TIMEOUT, tokio::net::lookup_host((host, 0)))
            .await
            .map_err(|_| Blocked::Unresolvable)?
            .map_err(|_| Blocked::Unresolvable)?
            .collect();
    if addrs.is_empty() {
        return Err(Blocked::Unresolvable);
    }
    if addrs.iter().any(|addr| !is_public(addr.ip())) {
        return Err(Blocked::Private);
    }
    Ok(addrs)
}

struct PublicOnly;

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            // The connector sets the port from the URL.
            let addrs = public_addrs(&host).await?;
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

/// Publicly reachable unicast address: not local, private, shared
/// (CGNAT), link-local, multicast, reserved or intended for documentation and
/// measurements. IPv6 only from 2000::/3, without 2001::/23
/// (protocols, Teredo), 2001:db8::/32 and 2002::/16 (6to4); IPv4 addresses
/// embedded in IPv6 count as IPv4.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(v4) => is_public_v4(v4),
            None => is_public_v6(ip),
        },
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    let internal = a == 0
        || a == 10
        || a == 127
        // Multicast, reserved, broadcast
        || a >= 224
        || (a == 100 && (64..128).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..32).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113);
    !internal
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let [s0, s1, ..] = ip.segments();
    let global_unicast = s0 & 0xe000 == 0x2000;
    global_unicast && !(s0 == 0x2001 && (s1 < 0x0200 || s1 == 0x0db8)) && s0 != 0x2002
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public(ip: &str) -> bool {
        is_public(ip.parse().unwrap())
    }

    #[test]
    fn only_public_unicast_addresses() {
        for ip in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.8",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.9",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::a00:1",
            "fc00::1",
            "fd12::1",
            "fe80::1",
            "ff02::1",
            "2001::1",
            "2001:db8::1",
            "2002:7f00:1::1",
        ] {
            assert!(!public(ip), "{ip} counts as public");
        }
        for ip in [
            "1.1.1.1",
            "100.63.255.255",
            "100.128.0.1",
            "172.15.0.1",
            "172.32.0.1",
            "185.10.20.30",
            "::ffff:185.10.20.30",
            "2a01:4f8::1",
            "2606:4700::1111",
        ] {
            assert!(public(ip), "{ip} counts as internal");
        }
    }

    #[tokio::test]
    async fn checks_literals_and_names() {
        let check = |url: &str| {
            let url = Url::parse(url).unwrap();
            async move { check_public(&url).await }
        };
        assert_eq!(check("https://127.0.0.1").await, Err(Blocked::Private));
        assert_eq!(check("https://10.0.0.5:8443").await, Err(Blocked::Private));
        assert_eq!(check("https://[::1]").await, Err(Blocked::Private));
        assert_eq!(check("https://185.10.20.30").await, Ok(()));
        // `localhost` resolves without a DNS server (operating system).
        assert_eq!(check("https://localhost").await, Err(Blocked::Private));
    }

    #[tokio::test]
    async fn client_refuses_internal_names() {
        let client = public_client().unwrap();
        // A local service would be reachable; the resolver does not allow it.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let error = client
            .get(format!("http://localhost:{port}/"))
            .send()
            .await
            .unwrap_err();
        assert!(error.is_connect(), "{error:?}");
    }
}
