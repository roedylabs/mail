//! `roedy-mail healthcheck`: queries `/healthz` of the running server. The
//! image contains no curl, so the command speaks HTTP/1.1 directly over TCP.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use anyhow::{Context as _, anyhow, bail};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader},
    net::TcpStream,
};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);

/// Longest accepted status line.
const MAX_STATUS_LINE: u64 = 1024;

/// Succeeds if `GET /healthz` responds with 200.
pub async fn check(listen: SocketAddr, timeout: Duration) -> anyhow::Result<()> {
    let addrs = probe_addrs(listen);
    let shown = addrs
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(" or ");
    tokio::time::timeout(timeout, async {
        // Tries the addresses in order.
        let stream = TcpStream::connect(&addrs[..])
            .await
            .with_context(|| format!("no connection to {shown}"))?;
        request(stream).await
    })
    .await
    .map_err(|_| anyhow!("{shown} does not respond within {timeout:?}"))?
}

/// If the server listens on all addresses, the check runs locally over
/// loopback. On Linux `[::]` also accepts IPv4; containers without IPv6 lack
/// `::1`, so `127.0.0.1` is tried as well.
fn probe_addrs(listen: SocketAddr) -> Vec<SocketAddr> {
    let port = listen.port();
    let v4 = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    match listen.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => vec![v4],
        IpAddr::V6(ip) if ip.is_unspecified() => {
            vec![SocketAddr::from((Ipv6Addr::LOCALHOST, port)), v4]
        }
        _ => vec![listen],
    }
}

async fn request(mut stream: TcpStream) -> anyhow::Result<()> {
    let addr = stream.peer_addr()?;
    stream
        .write_all(
            format!("GET /healthz HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await?;

    let mut line = String::new();
    BufReader::new(stream.take(MAX_STATUS_LINE))
        .read_line(&mut line)
        .await
        .context("no response")?;
    let line = line.trim_end();
    let mut parts = line.split(' ');
    match (parts.next(), parts.next()) {
        (Some(version), Some("200")) if version.starts_with("HTTP/1.") => Ok(()),
        _ if line.is_empty() => bail!("empty response from {addr}"),
        _ => bail!("/healthz responds with \"{line}\""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// Answers exactly one connection with `response`.
    async fn serve_once(response: &'static str) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await.unwrap();
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        addr
    }

    #[test]
    fn probes_loopback_for_unspecified_address() {
        let probe = |s: &str| {
            probe_addrs(s.parse().unwrap())
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        };
        assert_eq!(probe("0.0.0.0:8080"), ["127.0.0.1:8080"]);
        assert_eq!(probe("[::]:8080"), ["[::1]:8080", "127.0.0.1:8080"]);
        assert_eq!(probe("192.0.2.7:9000"), ["192.0.2.7:9000"]);
    }

    #[tokio::test]
    async fn unspecified_v6_falls_back_to_v4() {
        let addr = serve_once("HTTP/1.1 200 OK\r\n\r\n").await;
        let listen = SocketAddr::from((Ipv6Addr::UNSPECIFIED, addr.port()));
        check(listen, DEFAULT_TIMEOUT).await.unwrap();
    }

    #[tokio::test]
    async fn accepts_ok() {
        let addr = serve_once("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").await;
        check(addr, DEFAULT_TIMEOUT).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_error_status() {
        let addr = serve_once("HTTP/1.1 503 Service Unavailable\r\n\r\n").await;
        let err = check(addr, DEFAULT_TIMEOUT).await.unwrap_err();
        assert!(err.to_string().contains("503"), "{err}");
    }

    #[tokio::test]
    async fn rejects_garbage() {
        let addr = serve_once("SSH-2.0-OpenSSH\r\n").await;
        assert!(check(addr, DEFAULT_TIMEOUT).await.is_err());
    }

    #[tokio::test]
    async fn fails_without_server() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let err = check(addr, DEFAULT_TIMEOUT).await.unwrap_err();
        assert!(err.to_string().contains("no connection"), "{err}");
    }

    #[tokio::test]
    async fn times_out_on_silent_server() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let err = check(addr, Duration::from_millis(100)).await.unwrap_err();
        assert!(err.to_string().contains("does not respond"), "{err}");
        drop(listener);
    }
}
